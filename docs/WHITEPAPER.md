# EticaHub Whitepaper

**Version 1.0 — Launch Edition**

---

## Abstract

EticaHub is a community-built application layer on the Etica blockchain. It introduces **ETX** (ticker `ETX`, name `EticaHub`, supply 100,000,000, fixed), a hub-and-spoke decentralized exchange where every pair shares ETX as its reserve asset, a research subscription and tipping layer that reads Etica's native proposal contract, and a pre-designed (but not yet deployed) proposal-gated token launchpad that, when activated, will require every new token to open both a `token/ETX` and a `token/ETI` pool — structurally funnelling demand to both assets.

This document describes what EticaHub is, what it is not, how the v1 mainnet launch works, and what we explicitly defer to later phases.

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
5. **Defer complexity.** Features that require healthy base liquidity (launchpad, staking, emissions) are **designed and contract-complete** but deliberately not shipped in v1 so that v1 is small, auditable, and low-surface-area.

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
| `EticaSwapFactory` | Deploys pair contracts via CREATE2. Enforces ETX hub rule. Holds the optional `feeTo` treasury and the `trustedCreators` allow-list (§7). |
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

- The fee is **skipped when `feeTo == 0x0`**, so the factory can bootstrap before the treasury wallet is wired. This is used during launch day: the first two pools (ETI/ETX, EGAZ/ETX) are seeded free, then treasury wiring activates the fee for all subsequent pools.
- Addresses in the `trustedCreators` allow-list are **exempt** from the fee. This exists so the future launchpad (§7) does not double-charge its creators, since the launchpad already collects its own 250 ETX + 250 ETI fee per launch.
- The fee is **adjustable** by the `feeToSetter` governance key via `setPairCreationFee(uint256)`. It may be raised, lowered, or set to zero.
- The router transparently forwards the fee on first-time pair creation: users simply approve a slightly larger ETX budget to the router, no extra transaction is required.

### 4.3 Hub-and-spoke rationale

A typical AMM allows any token pair, which fragments liquidity across N² potential pairs for N assets. EticaSwap instead forces every asset to share a common quote (ETX). For N assets, this creates exactly N pools and guarantees every asset is reachable from every other asset through the ETX hub. The resulting ETX pool is, by construction, the DEX's deepest and most consequential market, aligning ETX with overall DEX health.

---

## 5. Launch Parameters (v1 Mainnet)

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

The v1 launch happens via three pages on [https://eticahub.com](https://eticahub.com):

1. `/deploy/etx` — one-click MetaMask deploy of `ETXToken`. Mints 100M to the connected wallet.
2. `/deploy/swap` — three-click deploy of `WEGAZ`, `EticaSwapFactory(etx)`, `EticaSwapRouter(factory, wegaz)`.
3. `/seed/pools` — four-step MetaMask flow (approve ETI, approve ETX, addLiquidity ETI/ETX, addLiquidityEGAZ ETX) that opens both launch pools.

Deployment artifacts (bytecode + ABI) are committed to the repo and reproducible from source.

---

## 6. Research Hub

Etica's native proposal contract (`EticaCoreProposals`) tracks medical-research proposals and their authors on-chain. EticaHub exposes these proposals through a reader UI at `/research/proposals` (Phase 2, already shipped), and adds two auxiliary primitives:

- **Tipping.** Visitors can tip a proposal author directly, in ETI or EGAZ, through a hosted contract that forwards to the author address recorded on-chain.
- **Subscription.** A `ResearchSubscription` contract sells monthly subscriptions in ETI that grant access to gated content via a simple `isActive(subscriber)` view. Subscriptions are paid upfront, extensible, and non-transferable.

The Research Hub is live today, independent of the DEX, and does not require ETX to function. It is the first concrete revenue surface for EticaHub's treasury (subscription payments flow to treasury as ETI).

---

## 7. Launchpad (Design Preview, Deferred to v2)

A creator-gated token launchpad (`ProposalTokenFactory`) is **designed, implemented, and unit-tested in the repo**, but **deliberately not deployed on mainnet as part of v1**. It will be activated as v2, once the base DEX and ETX have established a reliable price and sufficient liquidity depth.

### 7.1 Why

A launchpad is most useful once (a) the ETX pool has real depth, (b) the ETI/ETX pool has real depth, and (c) the DEX has seen meaningful organic volume. Launching the launchpad simultaneously with ETX itself would create paper-thin pools for every proposal token and serve no one well. We ship base infrastructure first.

### 7.2 Design summary (for v2 reference)

| Aspect | Decision |
|---|---|
| Who can launch | Only the wallet address recorded as `proposer` on the corresponding Etica proposal |
| One token per proposal | Yes, enforced on-chain |
| Supply split (BPS) | 25% LP → `token/ETX` pool, 25% LP → `token/ETI` pool, 25% liquid to author, 25% vested to author over 90 days |
| Launch fee | 250 ETX + 250 ETI to treasury |
| Minimum author-provided LP | 100 ETX + 50 ETI (per side) |
| Vesting | 90-day linear, via `ProposalTokenVesting` |
| Pool-creation fee (factory) | Exempt (launchpad is in `trustedCreators` allow-list) |

### 7.3 Why dual-pairing (token/ETX + token/ETI)

An earlier single-hub design (ETX-only) was rejected by the community on the grounds that every launched token would concentrate demand onto ETX at ETI's expense. The dual-pairing requirement makes every launch an ETI demand sink: each launch must supply at least 50 ETI plus a 250 ETI fee, and a `token/ETI` pool is opened alongside the `token/ETX` pool. The launchpad is structurally accretive to **both** ETX and ETI, not a dilutive substitute for ETI.

### 7.4 v1 does not include

- `/deploy/launchpad` page
- `/launch/token` author-facing UI
- Any mainnet deploy of `ProposalTokenFactory`, `ProposalToken`, or `ProposalTokenVesting`
- Any `factory.setTrustedCreator(launchpad, true)` call

All of the above are deferred. When activated, a separate announcement and documentation update will precede it.

---

## 8. Bridge (Phase 3, Contracts Ready, Launch Separate)

A production-grade bridge stack (`EticaBridgeVault`, `EticaBridgeMinter`, `MultisigVerifier`, and a Node relayer with per-validator signers and a coordinator) exists in the repo. It is designed to move ETI/ERC-20 assets between Etica mainnet and external chains via a k-of-n multisig of independent validators.

The bridge has its own audit scope and operational requirements (validator recruitment, key custody, monitoring) that are orthogonal to the DEX launch. It is **not activated as part of ETX + EticaSwap v1** and will be announced on its own timeline.

---

## 9. Governance and Treasury

### 9.1 Treasury wallet

The EticaHub treasury is an EOA at `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D`. It holds:

- Essentially all of the ETX supply at genesis (minus the amount seeded into pools).
- LP tokens for the initial ETI/ETX and EGAZ/ETX pools.
- Any future subscription revenue, swap protocol fees (after `feeTo` is set), and pool-creation fees.

### 9.2 Administrative keys

The Factory has two admin keys, both controlled by the treasury address at launch:

| Role | Key | Capabilities |
|---|---|---|
| `feeToSetter` | Treasury wallet | Can set `feeTo`, rotate `feeToSetter`, modify `pairCreationFee`, and flip `trustedCreators` entries |
| `feeTo` | Treasury wallet (set post-launch) | Receives the 0.05% protocol swap fee and the 10,000 ETX pool-creation fee |

The `feeToSetter` key is intentionally low-ceremony at launch (EOA) to minimize operational risk during the first few weeks. It will be migrated to a multi-signature wallet as a follow-up, announced separately.

### 9.3 On-chain authority of ETX

ETX itself has no admin — no pause, no mint, no blacklist, no upgrade. Governance in the "change the token" sense is impossible because the contract has no mutable configuration. All governance discretion is exercised over the DEX and treasury, not over ETX.

---

## 10. Security

- **Foundry test coverage:** 57 tests across swap, research, and launchpad contracts, all passing.
- **Pinned dependencies:** OpenZeppelin v5.1.0 (pinned specifically to avoid Cancun-only `mcopy` on Etica's Paris-EVM).
- **No upgradeability / no proxies:** Every contract is deployed at its final implementation. There is no upgrade path that could silently change logic.
- **No admin mints:** ETX supply is fixed at deploy.
- **No external audits at launch.** v1 ships without a third-party audit. Users should size their exposure accordingly. Audits are on the roadmap (§11) and will be announced once scoped.

---

## 11. Roadmap

Timeline is indicative, not committed.

- **v1 — ETX genesis (this launch):** ETX deployed, EticaSwap deployed, ETI/ETX and EGAZ/ETX pools seeded, hub-and-spoke invariant active, pool-creation fee switch activated by setting `feeTo`. `eticahub.com` routes swaps through the new contracts.
- **v1.1 — addresses & docs:** deployed addresses wired into the repo's shared addresses module and Vercel env so the public UI auto-picks them up. Launch parameters frozen in `docs/launch-parameters.md`.
- **v1.2 — multisig treasury migration:** `feeToSetter` rotated from the launch EOA to a multi-sig.
- **v2 — launchpad activation:** `ProposalTokenFactory` deployed to mainnet, `factory.setTrustedCreator(launchpad, true)` wired, `/launch/token` UI shipped. Dependent on ETX establishing meaningful depth (≥ $X, TBD) and community signal.
- **v3+ — bridge activation; emissions / staking (if demanded by liquidity):** TBD.

---

## 12. Risks

This section is non-exhaustive. ETX and EticaHub are **experimental software** and exposure should be sized accordingly.

- **Liquidity risk.** The launch pools are intentionally small (~$6 total at NonKYC reference prices). Trades of even a few dollars will move price substantially. Depth will grow only as organic volume and LPs arrive.
- **Smart-contract risk.** v1 ships without a third-party audit.
- **Regulatory risk.** Despite the fair-launch structure (no sale, no allocation, no vesting, no promises), any token that has a market value is subject to interpretation by various regulators in various jurisdictions. ETX is not offered for sale anywhere; users who acquire it on EticaSwap do so at their own risk and on their own legal assessment.
- **Chain risk.** The Etica blockchain itself is an independent L1 with its own validator set, its own client software, and its own operational history. EticaHub inherits all of Etica L1's risks (consensus, liveness, RPC availability, chain reorgs).
- **Team risk.** EticaHub is a small community-built project. There is no institutional backer and no formal legal entity.

---

## 13. FAQ

**Is ETX the same as ETI?**
No. ETI is Etica Protocol's native asset. ETX is EticaHub's own ERC-20, unrelated at the token level. They are connected only by the fact that EticaSwap trades them as the first-opened pool.

**Is EticaHub officially endorsed by the Etica Protocol core team?**
No. See §1.

**Can I buy ETX from the team?**
No. The team does not sell ETX. The only market is EticaSwap.

**Why such a small FDV?**
Small FDV + low LP depth keeps the initial unit price small ($0.00001/ETX) and reflects that real distribution happens post-launch as volume arrives, not at genesis. We explicitly do not want to open at a large implied FDV with no capital behind it.

**When does the launchpad open?**
Not v1. See §7 and §11. No date committed.

**Where is the code?**
[https://github.com/iamdexx/etica-hub](https://github.com/iamdexx/etica-hub) — monorepo, MIT-licensed.

---

## Appendix A — Canonical addresses

Etica mainnet (chain id `61803`). Also mirrored in `packages/shared/src/addresses.ts`.

| Contract | Address |
|---|---|
| ETX (`EticaHub`) | `0xa5A1Bc6307b0b87989B8456D4b35F88a68650044` |
| WEGAZ (`Wrapped EGAZ`) | `0x232fb2B87CAce92B2438054A7eB79B4081E3E11a` |
| EticaSwapFactory | `0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3` |
| EticaSwapRouter | `0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723` |
| ETI/ETX pool | *derived from `factory.getPair(ETI, ETX)` after seeding* |
| EGAZ/ETX pool | *derived from `factory.getPair(WEGAZ, ETX)` after seeding* |
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
| Block explorer | `https://eticascan.org` |
| Canonical ETI address | `0x34c61EA91bAcdA647269d4e310A86b875c09946f` |

---

*EticaHub is an independent, community-built project. This document describes EticaHub's own design and contracts. It does not speak for, commit, or represent the Etica Protocol core team in any capacity.*
