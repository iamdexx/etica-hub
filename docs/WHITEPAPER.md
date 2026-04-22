# EticaHub Whitepaper

**Version 1.1 — Post-Launch Edition**

---

## Abstract

EticaHub is a community-built application layer on the Etica blockchain. It introduces **ETX** (ticker `ETX`, name `EticaHub`, supply 100,000,000, fixed), a hub-and-spoke decentralized exchange where every pair shares ETX as its reserve asset, a research subscription and tipping layer that reads Etica's native proposal contract, and a pre-designed (but not yet deployed) proposal-gated token launchpad that, when activated, will require every new token to open both a `token/ETX` and a `token/ETI` pool — structurally funnelling demand to both assets.

Since the v1 genesis launch, EticaHub has shipped several additional surfaces — all of them non-custodial, non-dilutive to the fixed ETX supply, and built on the same hub-and-spoke invariant: a UniswapX-style **Trading Stack** (limit, stop, DCA, bounded grid, Infinity Bot), an **ERC-4626 liquid staking vault (stETX)**, an on-chain **Treasury Harvester** that redistributes treasury LP-fee accruals via a deterministic 10/10/40/40 split with a permanent Protocol-Owned-Liquidity (POL) burn, a skinny **on-chain explorer** with Sourcify-backed contract verification, a public **market-data API**, and a **community buy bot** that posts DEX swaps to Telegram.

This document describes what EticaHub is, what it is not, how the v1 mainnet launch works, what has shipped since, and what remains explicitly deferred to later phases.

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

1. **Make ETI more useful.** Etica's native asset is ETI. We build tools (a DEX, a research hub, a bridge, and eventually a launchpad) whose cash flows and demand vectors grow ETI's utility as a byproduct.
2. **Introduce a reward / coordination token (ETX) without diluting ETI.** ETX is a separate asset for EticaHub-specific cash flow capture: swap fees, pool-creation fees, and (later) launchpad fees. It does not replace, fork, or compete with ETI.
3. **Hub-and-spoke liquidity.** Rather than fragment liquidity across arbitrary pairs, the DEX enforces that every pair shares a common reserve (ETX). This turns ETX into the unit of DEX-wide convertibility.
4. **Fair launch, no presale, no allocation.** ETX is seeded entirely via on-chain AMM pools opened by the EticaHub treasury with its own capital. There is no private round, public round, airdrop, team allocation, advisor allocation, vesting cliff, or unlock schedule for ETX supply.
5. **No new emissions, ever.** Every redistribution surface (stETX yield, Harvester, farms, buybacks) must be funded from *existing* DEX cash flows — LP fees, swap protocol fees, subscription revenue — and never by minting more ETX.
6. **Defer complexity with safety margins.** Features that materially touch user funds (launchpad, bridge) are contract-complete but deliberately not activated until there is organic depth and demand. Features that touch only the *treasury's own* capital (Harvester, POL burns, stETX yield) ship earlier because the blast radius is internal.

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
| `EticaSwapFactory` | Deploys pair contracts via CREATE2. Enforces ETX hub rule. Holds the optional `feeTo` treasury and the `trustedCreators` allow-list (§13). |
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
- Addresses in the `trustedCreators` allow-list are **exempt** from the fee. This exists so the future launchpad (§13) does not double-charge its creators, since the launchpad already collects its own 250 ETX + 250 ETI fee per launch.
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

The full EticaHub frontend lives at [https://eticahub.org](https://eticahub.org), hosted on Vercel out of `apps/web`. The v1 genesis was executed via three operator-only deploy pages:

1. `/deploy/etx` — one-click MetaMask deploy of `ETXToken`. Minted 100M to the connected treasury wallet.
2. `/deploy/swap` — three-click deploy of `WEGAZ`, `EticaSwapFactory(etx)`, `EticaSwapRouter(factory, wegaz)`.
3. `/seed/pools` — four-step MetaMask flow (approve ETI, approve ETX, addLiquidity ETI/ETX, addLiquidityEGAZ ETX) that opened both launch pools.

Deploy pages are gated behind `NEXT_PUBLIC_OPERATOR_UI=true` and are **not** part of the public navigation. They are kept in the repo so that the full launch path is reproducible from source. Deployment artifacts (bytecode + ABI) are committed to the repo.

The public pages — `/swap`, `/pool`, `/trade`, `/stake`, `/bridge`, `/research`, `/explorer`, `/status`, `/whitepaper` — run against live mainnet contracts addressed from `packages/shared/src/addresses.ts` (canonical) and mirrored in Appendix A.

---

## 6. Research Hub

Etica's native proposal contract (`EticaCoreProposals`) tracks medical-research proposals and their authors on-chain. EticaHub exposes these proposals through a reader UI at `/research/proposals` (shipped with Phase 2), and adds two auxiliary primitives:

- **Tipping.** Visitors can tip a proposal author directly, in ETI or EGAZ, through a hosted contract that forwards to the author address recorded on-chain.
- **Subscription.** A `ResearchSubscription` contract sells monthly subscriptions in ETI that grant access to gated content via a simple `isActive(subscriber)` view. Subscriptions are paid upfront, extensible, and non-transferable.

The Research Hub is live today, independent of the DEX, and does not require ETX to function. It is the first concrete revenue surface for EticaHub's treasury (subscription payments flow to treasury as ETI).

---

## 7. Trading Stack (Live)

EticaSwap's Market tab handles immediate one-shot swaps against the AMM. Everything beyond that — limit orders, stop-losses, dollar-cost averaging, grid bots, and Infinity Bot — lives in the **Trading Stack**, exposed at `/trade/[token]`. The stack is non-custodial, modelled on UniswapX, and uses contracts audited independently of anything EticaHub wrote.

### 7.1 Components

| Component | Audited by | Role | Status |
|---|---|---|---|
| [Permit2](https://github.com/Uniswap/permit2) | OpenZeppelin, Trail of Bits, ABDK | One-time per-token approval. Signature-based allowances with per-user nonces and per-sig deadlines. | **Deployed** at `0x165F71f549415f44883e370Df12169Dd99570eE5` |
| [UniswapX `DutchOrderReactor`](https://github.com/Uniswap/UniswapX) | Uniswap Labs audit set | Settles pre-signed Dutch orders. Pulls input via Permit2, swaps through the EticaSwap Router, pushes output to the maker. | **Deployed** at `0xE2fc7EAcEB0146560bfcf46CC5B167df60E970B8` |
| `EticaProtocolFeeController` | — (60-line contract, deployed at 0 BPS) | Pluggable ETX-denominated protocol fee. Capped at 1% on-chain. v1 ships at **0 BPS**. | **Deployed** at `0xB9a4FbfC4cA598Be18e09bb9C0Cf19e4a1A4350a` |
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

### 7.5 Protocol fee posture at v1

The ETX-denominated fee hook is **deployed at 0 BPS**. There is no protocol take on any trade in v1. The reactor owner (currently the launch operator, rotating to the community multisig per the same schedule as `feeTo` in §4) can flip the fee on later — capped at 1% by the contract itself. When it flips on, the fee is denominated in ETX (every trade has an ETX leg thanks to hub-and-spoke), which routes all protocol revenue through an organic ETX buy rather than introducing a new fee currency.

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

### 8.5 Treasury seed stake (20M ETX)

The EticaHub treasury seeds stETX with **20,000,000 ETX** (20% of fixed supply) as a public commitment to the vault's design and to bootstrap non-zero TVL on day one. Concrete implications:

- **Real floor on TVL.** The `/stake` page does not open with an empty vault. APY math and exchange-rate history have a meaningful denominator from the first block.
- **Skin-in-the-game signal.** The treasury is the largest stETX holder. Every design decision about the vault applies to the treasury first — there is no separate "team pool" on better terms.
- **No special privileges.** The treasury's stETX shares are identical to any other depositor's. Treasury cannot front-run distributions, cannot block withdrawals, cannot mint extra shares. The `distributeRewards` path is permissionless and capped by the fees the harvester actually collected.
- **Dilutive to treasury by design.** As outside stakers deposit, treasury's proportional claim on the 10% harvest bucket falls. This is the intended direction: the seed stake exists to bootstrap credibility, not to lock in a permanent treasury revenue line. The 40% treasury bucket and the 40% POL burn (see §9) are unaffected by stETX participation.
- **Liquid commitment, not a rug-pull vector.** The 20M is held as stETX shares in the treasury wallet and is liquid under ERC-4626. Any intent to unwind would be fully visible on-chain as a `Redeem` event. A time-locked wrapper is under consideration as a follow-up (see roadmap).

---

## 9. Treasury Harvester & POL Flywheel

`TreasuryHarvester` is an on-chain delegation contract that formalizes how the treasury's own LP-fee accruals are redistributed. It exists so the keeper that performs the redistribution can run as a thin, inexpensive EOA with *narrowly scoped* authority, rather than as the treasury wallet itself.

### 9.1 Why a delegation contract

Before the Harvester, redistributing LP fees required the treasury EOA to sign a sequence of `removeLiquidity → swap → transfer → distributeRewards` transactions. That forced the treasury key to be online whenever a harvest was due, which is both operationally fragile and a key-compromise hazard.

The Harvester inverts this: the treasury one-time-approves the Harvester for ETX + both LP tokens, then delegates the actual redistribution work to a designated keeper EOA via `setKeeper(address)`. The keeper can now call `harvest()` on its own budget; it cannot touch treasury ETX for anything except the 10/10/40/40 split encoded in the contract.

### 9.2 10/10/40/40 split

Every successful `harvest()` call partitions the freshly-collected fee tranche (in ETX-equivalent) into four destinations:

| Bucket | Share | Destination |
|---|---|---|
| stETX yield | 10% | Forwarded to `StakedETX.distributeRewards` (retained in treasury until the vault is wired in on-chain) |
| Farms / LP incentives | 10% | Forwarded to the (future) `ETXFarms` contract; retained in treasury until farms are live |
| Treasury operations | 40% | Retained in treasury for audits, infra, community grants, reserves |
| **POL burn** | **40%** | **Paired with ETI/EGAZ and added to the ETI/ETX and EGAZ/ETX pools as LP, then the resulting LP tokens are sent to the burn sink — permanently locked liquidity** |

### 9.3 The POL burn is the flywheel

The 40% POL burn is the mechanism that makes every swap structurally accretive to pool depth *forever*. The fees leave the treasury, buy LP tokens, and burn them — depth stays in the pool and can never be withdrawn. Three consequences:

1. **Slippage curves improve monotonically.** Each harvest deepens the ETI/ETX and EGAZ/ETX pools, reducing slippage for every future trade.
2. **Depth is independent of any operator.** Because the LP tokens are burned, not held, no future EticaHub key rotation, key loss, or governance action can ever remove the burned depth.
3. **Volume begets depth begets volume.** Higher depth supports larger trades, larger trades generate more fees, more fees feed more harvests, more harvests burn more POL. The loop is self-reinforcing and requires no emissions to sustain.

### 9.4 Status

The Harvester contract is **deployed and unit-tested** (`packages/contracts/test/TreasuryHarvester.t.sol`, 7 forge tests covering the 10/10/40/40 invariant, the POL burn path, keeper-gating, and treasury-owner overrides). **Its mainnet address is not yet wired into `packages/shared/src/addresses.ts`** (see Appendix A) because the treasury-approve + keeper-handoff sequence has not been executed yet. When it is, the keeper workflow in `.github/workflows/harvest-live.yml` will be flipped from dry-run to live mode, and this section will be updated to reflect the live cadence.

The live-mode workflow is `workflow_dispatch`-only, gated behind a `harvest-live` GitHub Environment secret, and requires the operator to type a confirmation string before execution. See [`docs/HARVESTER_EGAZ_RUNBOOK.md`](./HARVESTER_EGAZ_RUNBOOK.md) for the full operational runbook.

### 9.5 Hot-keeper budgeting

The keeper EOA only needs a small EGAZ balance (for gas) and *no* ETX, ETI, or LP tokens. Specifically: it holds nothing, it transfers nothing on its own account, it just calls `harvester.harvest()`. If the keeper key is ever compromised, the worst an attacker can do is burn gas calling `harvest()` — which does nothing they don't already get paid for as any other keeper would. Scope of damage is bounded by the contract, not by the keeper's custody posture.

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

**Owner scope.** The contract owner can register new pools, retune weights, and set the fallback recipient. The owner *cannot* steal staked LP (`rescueToken` is explicitly guarded against rescuing any registered LP token or the reward token ETX). The owner *cannot* pause withdrawals. The owner *cannot* change reward semantics retroactively. Owner will be rotated to the same multisig that holds `feeToSetter` and `TreasuryHarvester.owner` as part of the near-term multisig migration (§17).

**Audit posture.** Forge unit tests cover: metadata and shape, owner-only gates, deposit/withdraw mechanics, accumulator math for the solo-staker and two-staker-pro-rata cases, multi-harvest sequencing, late-joiner protection, empty-pool fallback routing, emergency withdrawal, rescue guards, and permissionless `distributeRewards` parity. No external audit has been commissioned for v1.1 — same posture as stETX and the Harvester. External review will be scoped once the broader v1.1 surface stabilizes.

**Deployment.** Operators deploy via `/deploy/farms` (browser-based, signs from the connected wallet). Post-deploy: paste the address into `packages/shared/src/addresses.ts → DEPLOYMENTS[61803].etxFarms`, call `addPool(ETI/ETX LP, 5000)` and `addPool(EGAZ/ETX LP, 5000)`, then call `TreasuryHarvester.setFarms(etxFarms)` to route the 10% farms bucket. `/farms` will light up the moment the address is non-zero.

---

## 10. EticaHub Explorer

A skinny on-chain explorer lives at `/explorer`, powered by the same JSON-RPC node the rest of the site uses plus a lightweight JSONL indexer (see §10.3). It exists so that a user clicking a tx hash from `/swap`, `/trade`, or the Telegram buy bot (§12) lands on a first-party page under the EticaHub domain rather than an off-site explorer.

### 10.1 Pages

| Route | Purpose |
|---|---|
| `/explorer` | Latest blocks and transactions |
| `/explorer/block/[n]` | Block detail: header, tx list, gas used |
| `/explorer/tx/[hash]` | Tx detail: decoded calldata, decoded event logs, status, gas |
| `/explorer/address/[addr]` | Address detail: balance, token balances, recent txs, ERC-20 transfers |
| `/explorer/token/[addr]` | ERC-20 token page: metadata, holders, transfers, price, OHLCV |
| `/explorer/gas` | Live gas tracker: rolling fee stats over recent blocks |
| `/explorer/verify/[addr]` | Contract verification submission |

### 10.2 Sourcify-backed verification

Contract source verification uses [Sourcify](https://sourcify.dev) as the canonical source of truth. Users (or operators) submit a compilation artifact + sources at `/explorer/verify/[addr]`; the explorer pushes them to Sourcify, which publishes a verified metadata record. The explorer then reads back the verified ABI + sources to decode calldata and events on the tx and contract pages. There is no EticaHub-owned verification registry — we rely on Sourcify so verifications are portable to any other explorer that reads from Sourcify. See [`docs/SOURCIFY_CHAIN_ADD.md`](./SOURCIFY_CHAIN_ADD.md) for how chain 61803 was added.

### 10.3 On-chain + JSONL indexer

The explorer reads from two data sources, in order of preference:

1. **Gzipped JSONL shards** produced by a GitHub Actions cron at `.github/workflows/explorer-indexer.yml`. The indexer walks `Swap` and ERC-20 `Transfer` logs in block-range batches, writes them to size-capped JSONL shards (`apps/indexer/data/*.jsonl.gz`), and commits the shards back to the repo. This makes address + token pages fast for historical data without hammering the RPC.
2. **Live RPC fallback.** If a shard is missing or malformed, the reader falls back to `eth_getLogs` on the live RPC. The fallback is silent to the user and intentionally conservative (narrow block ranges, bounded retries) so a bad shard never breaks a page.

---

## 11. Public Market Data API

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

## 12. Community Buy Bot

A Vercel-cron-hosted Telegram bot posts every swap on every ETX pair to the EticaHub community group. It is a downstream consumer of the same RPC + indexer layer as the explorer; it does not touch user funds and has no privileged access.

### 12.1 Architecture

The bot lives as a single Next.js route (`apps/web/src/app/api/cron/buybot/route.ts`) invoked by Vercel's cron scheduler at 1-minute cadence. Each invocation:

1. Reads the last-scanned block cursor from Vercel KV.
2. Calls `eth_getLogs` for every `Swap` event on every ETX pair between `lastScannedBlock + 1` and `latest`.
3. Snapshots each pool's post-swap reserves + relevant token metadata (name, symbol, supply).
4. Pulls USD anchors from NonKYC's public API (ETI/USDT, EGAZ/USDT spot).
5. Derives ETX/USD from the first pool in the window that pairs ETX with ETI or EGAZ.
6. For each swap, renders a message with the side bought, amounts in and out, ETX + USD prices, market caps of both tokens, and links to the `/explorer/tx/[hash]` and `/explorer/block/[n]` pages.
7. POSTs to `api.telegram.org/bot<token>/sendMessage`.
8. Writes the new block cursor.

### 12.2 Safety rails

- **Per-swap dedup.** Every posted swap is claimed in KV by `(txHash, logIndex)` with a 24-hour TTL. A pre-check skips any swap that was already claimed, even if the block cursor rewinds. The claim is written *after* a successful Telegram send, never before, so a failed send never locks a swap out of retries. Transient KV failures (read or write) are swallowed; the worst case is one duplicate post once KV recovers.
- **Min-USD floor.** Swaps below a configurable USD notional are skipped to avoid spam on dust trades.
- **No private keys.** The bot holds no funds, signs no transactions, has no on-chain authority.
- **Failure mode: silent.** A missing env var, a dead RPC, a Telegram rate-limit, or an indexer stall all degrade to "no messages posted this minute". The cron simply re-runs on the next tick and catches up.

### 12.3 Why Vercel cron instead of a long-lived WebSocket

A WebSocket listener is the canonical architecture for a buy bot and is ~30s faster, but it requires always-on hosting (Fly, a VPS, etc.) and its own monitoring. Vercel cron is $0, redeploys on every `git push` alongside the rest of the site, and logs every invocation in the Vercel dashboard. The ~60s lag is acceptable for a community ticker.

---

## 13. Launchpad (Design Preview, Deferred to v2)

A creator-gated token launchpad (`ProposalTokenFactory`) is **designed, implemented, and unit-tested in the repo**, but **deliberately not deployed on mainnet as part of v1**. It will be activated as v2, once the base DEX and ETX have established a reliable price and sufficient liquidity depth.

### 13.1 Why

A launchpad is most useful once (a) the ETX pool has real depth, (b) the ETI/ETX pool has real depth, and (c) the DEX has seen meaningful organic volume. Launching the launchpad simultaneously with ETX itself would create paper-thin pools for every proposal token and serve no one well. We ship base infrastructure first.

### 13.2 Design summary (for v2 reference)

| Aspect | Decision |
|---|---|
| Who can launch | Only the wallet address recorded as `proposer` on the corresponding Etica proposal |
| One token per proposal | Yes, enforced on-chain |
| Supply split (BPS) | 25% LP → `token/ETX` pool, 25% LP → `token/ETI` pool, 25% liquid to author, 25% vested to author over 90 days |
| Launch fee | 250 ETX + 250 ETI to treasury |
| Minimum author-provided LP | 100 ETX + 50 ETI (per side) |
| Vesting | 90-day linear, via `ProposalTokenVesting` |
| Pool-creation fee (factory) | Exempt (launchpad is in `trustedCreators` allow-list) |

### 13.3 Why dual-pairing (token/ETX + token/ETI)

An earlier single-hub design (ETX-only) was rejected by the community on the grounds that every launched token would concentrate demand onto ETX at ETI's expense. The dual-pairing requirement makes every launch an ETI demand sink: each launch must supply at least 50 ETI plus a 250 ETI fee, and a `token/ETI` pool is opened alongside the `token/ETX` pool. The launchpad is structurally accretive to **both** ETX and ETI, not a dilutive substitute for ETI.

### 13.4 v1 does not include

- `/deploy/launchpad` page (operator-only)
- `/launch/token` author-facing UI
- Any mainnet deploy of `ProposalTokenFactory`, `ProposalToken`, or `ProposalTokenVesting`
- Any `factory.setTrustedCreator(launchpad, true)` call

All of the above are deferred. When activated, a separate announcement and documentation update will precede it.

---

## 14. Bridge (Phase 3, Contracts Ready, Launch Separate)

A production-grade bridge stack (`EticaBridgeVault`, `EticaBridgeMinter`, `MultisigVerifier`, and a Node relayer with per-validator signers and a coordinator) exists in the repo. It is designed to move ETI/ERC-20 assets between Etica mainnet and external chains via a k-of-n multisig of independent validators.

The bridge has its own audit scope and operational requirements (validator recruitment, key custody, monitoring) that are orthogonal to the DEX launch. It is **not activated as part of ETX + EticaSwap v1** and will be announced on its own timeline.

---

## 15. Governance and Treasury

### 15.1 Treasury wallet

The EticaHub treasury is an EOA at `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D`. It holds:

- Essentially all of the ETX supply at genesis (minus the amount seeded into pools).
- LP tokens for the initial ETI/ETX and EGAZ/ETX pools (less whatever fraction has been moved through the future TreasuryHarvester POL-burn path, which permanently locks LP tokens to the burn sink).
- Any subscription revenue, swap protocol fees (after `feeTo` is set), and pool-creation fees.
- Any undistributed portion of the 10% farm bucket from the Harvester (parked in treasury until `ETXFarms` is live).

### 15.2 Administrative keys

| Contract | Key | Capabilities |
|---|---|---|
| `EticaSwapFactory` — `feeToSetter` | Treasury wallet | Can set `feeTo`, rotate `feeToSetter`, modify `pairCreationFee`, and flip `trustedCreators` entries |
| `EticaSwapFactory` — `feeTo` | Treasury wallet | Receives the 0.05% protocol swap fee and the 10,000 ETX pool-creation fee |
| `DutchOrderReactor` — `owner` | Treasury wallet | Can change the protocol fee controller; fee itself capped at 1% by the controller |
| `EticaProtocolFeeController` — `owner` | Treasury wallet | Can flip the ETX-denominated protocol fee between 0 and 100 BPS |
| `StakedETX` | **no owner** | Contract has no `Ownable` inheritance; `distributeRewards` is permissionless; **cannot** seize deposits, pause, or mint shares |
| `TreasuryHarvester` — `owner` | Treasury wallet | Can rotate the keeper EOA, emergency-sweep to treasury, and tune the 10/10/40/40 split within contract-enforced caps |
| `TreasuryHarvester` — `keeper` | Hot keeper EOA | Can call `harvest()` only — cannot change parameters, cannot drain funds |

The `feeToSetter` key is intentionally low-ceremony at launch (EOA) to minimize operational risk during the first few weeks. It will be migrated to a multi-signature wallet as a follow-up, announced separately.

### 15.3 On-chain authority of ETX

ETX itself has no admin — no pause, no mint, no blacklist, no upgrade. Governance in the "change the token" sense is impossible because the contract has no mutable configuration. All governance discretion is exercised over the DEX and treasury, not over ETX.

---

## 16. Security

- **Foundry test coverage:** 70+ tests across swap, research, launchpad, UniswapX reactor wiring, stETX, and TreasuryHarvester contracts, all passing in CI.
- **Pinned dependencies:** OpenZeppelin v5.1.0 (pinned specifically to avoid Cancun-only `mcopy` on Etica's Paris-EVM).
- **No upgradeability / no proxies:** Every contract is deployed at its final implementation. There is no upgrade path that could silently change logic.
- **No admin mints:** ETX supply is fixed at deploy. stETX shares can only be minted in exchange for ETX deposits.
- **No custody paths:** `StakedETX` has no owner at all — `distributeRewards` is permissionless and can only *increase* the exchange rate. Harvester keeper can only perform the 10/10/40/40 redistribution. Reactor owner can only toggle a capped protocol fee. No key in the system can unilaterally drain user funds.
- **No external audits at launch.** v1 ships without a third-party audit. Users should size their exposure accordingly. Audits are on the roadmap (§17) and will be announced once scoped.

---

## 17. Roadmap

Timeline is indicative, not committed.

### Shipped

- **v1 — ETX genesis:** ETX deployed, EticaSwap deployed, ETI/ETX and EGAZ/ETX pools seeded, hub-and-spoke invariant active, pool-creation fee switch activated by setting `feeTo`. `eticahub.org` routes swaps through the new contracts.
- **v1 — Research Hub:** `/research/proposals` reader, tipping, subscription contract.
- **v1.1 — Trading Stack:** Permit2 + UniswapX DutchOrderReactor + EticaProtocolFeeController + OrderRegistry + off-chain order book + reference keeper. Market, Limit, Stop, DCA, bounded Grid, and Infinity Bot modes all live on `/trade/[token]`.
- **v1.1 — Explorer:** `/explorer` with blocks, txs, addresses, ERC-20 token pages, gas tracker, Sourcify-backed verification, JSONL indexer.
- **v1.1 — Market Data API:** `/api/v1/*` pools, pairs, candles, tokens, health endpoints. Aggregator submission briefs.
- **v1.1 — Staking (stETX):** ERC-4626 liquid staking vault, `/stake` UI with deposit, withdraw, 7d APY, exchange-rate chart.
- **v1.1 — TreasuryHarvester contract:** 10/10/40/40 split + POL burn, deployed and unit-tested; mainnet wire-in + delegation-mode keeper flip pending.
- **v1.1 — Community Buy Bot:** Vercel-cron Telegram posts for all ETX-pair swaps with KV-based dedup.
- **v1.1 — Mobile wallet UX:** MetaMask deep-link + WalletConnect v2 connector.
- **v1.1 — Addresses & docs:** deployed addresses wired into `packages/shared/src/addresses.ts`; launch parameters and harvester runbook frozen in `docs/`.

### Near-term

- **Harvester live cutover:** treasury approves, keeper rotates, `.github/workflows/harvest-live.yml` flipped to live.
- **ETXFarms deployment:** contract + tests + `/deploy/farms` deployer + `/farms` staking UI shipped (see §9.6); remaining step is the on-chain deploy, `addPool` × 2, and `TreasuryHarvester.setFarms` wiring. Once live, the 10% farm bucket flows automatically on every harvest.
- **Multisig treasury migration:** `feeToSetter`, `DutchOrderReactor` owner, `EticaProtocolFeeController` owner, and `TreasuryHarvester` owner all rotated from the launch EOA to a multi-sig. (`StakedETX` has no owner — nothing to rotate.)

### Mid-term

- **Launchpad activation (v2):** `ProposalTokenFactory` deployed to mainnet, `factory.setTrustedCreator(launchpad, true)` wired, `/launch/token` UI shipped. Dependent on ETX establishing meaningful depth and community signal.
- **Bridge activation (v3):** validator recruitment, audit, relayer deployment, `/bridge` flipped live.
- **External audits:** to be scoped and announced as the protocol matures.

---

## 18. Risks

This section is non-exhaustive. ETX and EticaHub are **experimental software** and exposure should be sized accordingly.

- **Liquidity risk.** The launch pools were intentionally small (~$6 total at NonKYC reference prices). Trades of even a few dollars move price substantially. Depth grows only as organic volume, LPs, and (future) POL-burn harvests arrive.
- **Smart-contract risk.** v1 ships without a third-party audit. Every surface (DEX, Trading Stack, stETX, Harvester) is tested but unaudited.
- **Regulatory risk.** Despite the fair-launch structure (no sale, no allocation, no vesting, no promises), any token that has a market value is subject to interpretation by various regulators in various jurisdictions. ETX is not offered for sale anywhere; users who acquire it on EticaSwap do so at their own risk and on their own legal assessment. stETX is likewise not sold; it is minted 1:1 against deposited ETX.
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

**When does the launchpad open?**
Not v1. See §13 and §17. No date committed.

**Is the buy bot official? Is it custodial?**
Yes, operated by EticaHub. Non-custodial: the bot reads on-chain `Swap` logs and posts messages. It holds no funds, signs no transactions, and has no privileged access. See §12.

**How do I verify a contract?**
Submit source + metadata at `/explorer/verify/[addr]`; we push to Sourcify. Once Sourcify acks, the explorer reads back the verified ABI + sources on every tx and contract page. See §10.2.

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
| `TreasuryHarvester` | *pending mainnet deploy + treasury-approve handoff — see §9.4* |
| `ResearchSubscription` | *pending deploy* |
| ETI (Etica protocol, external) | `0x34c61EA91bAcdA647269d4e310A86b875c09946f` |
| Treasury wallet | `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D` |

---

## Appendix B — Chain parameters

| Parameter | Value |
|---|---|
| Network name | Etica Mainnet |
| RPC URL | `https://eticamainnet.eticascan.org` |
| Chain ID | 61803 |
| Native gas token | EGAZ |
| Block explorer (EticaHub) | `https://eticahub.org/explorer` |
| Block explorer (Etica Protocol) | `https://eticascan.org` |
| Canonical ETI address | `0x34c61EA91bAcdA647269d4e310A86b875c09946f` |

---

*EticaHub is an independent, community-built project. This document describes EticaHub's own design and contracts. It does not speak for, commit, or represent the Etica Protocol core team in any capacity.*
