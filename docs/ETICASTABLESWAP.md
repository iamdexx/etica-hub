# EticaStableSwap — rate-aware stETX/ETX pool

**Status:** Draft, contracts compile, 27/27 unit tests pass. Not deployed.

EticaStableSwap is a custom Curve-style AMM specialised for the
stETX/ETX pair. It reads stETX's ERC-4626 NAV on every swap so the peg
is always at the live exchange rate and never drifts out of range as
stETX yield compounds. Phase 0 of the EticaHub stableswap roadmap.

## Why a custom AMM and not V3

V3 concentrated liquidity gives you ~50–200x more depth at the trading
price — but **only inside the LP's chosen tick range**. stETX/ETX is
not a fixed-peg pair: the NAV (`stETX.convertToAssets(1e18)`) climbs
monotonically as the staking vault accrues rewards. A tight V3 range
that's correct today exits the band in ~12–18 months and earns zero
fees until somebody manually repositions.

Curve's stableswap invariant on **virtual balances** sidesteps this
entirely. The pool reads NAV live, scales the stETX leg into ETX-units,
runs the invariant in xp-space, and settles in physical tokens. Same
"infinite-depth at peg" property as Curve's stETH/ETH pool, but with
the peg permanently anchored to a vault rate that we already trust.

## Core contracts

| Contract | Lines | Role |
| --- | --- | --- |
| `EticaStableSwap.sol` | 785 | Rate-aware Curve-style AMM, ERC-20 LP shares with EIP-2612 permit, ramped A coefficient |
| `LiquidityTimelock10y.sol` | 160 | 10-year lock holder for the **treasury's seed LP only**. Public LPs are not locked. Fees are not locked. |
| `StableSwapHarvesterAdapter.sol` | 262 | Routes admin fees from the pool through the existing 10/10/40/40 TreasuryHarvester pattern, with the POL slice burned **into the stableswap pool itself** |

All three live under `packages/contracts/src/stableswap/`.

## Invariant math

Two coins (n=2), Curve constant-sum:

    A·n^n·sum(xp) + D = A·n^n·D + D^(n+1) / (n^n · prod(xp))

Virtual balances:

    xp[0] = reserveEtx                       (raw, ETX is the unit)
    xp[1] = reserveStEtx · rate / 1e18       (stETX → ETX-equivalent)

with `rate = stETX.convertToAssets(1e18)` re-read on every swap, deposit,
and withdrawal. `_getD` solves for the invariant via Newton iteration
(typically <10 steps, hard-bounded at 255). `_getY` solves for the new
post-trade balance of the output token. Slippage at peg is effectively
zero for trade sizes well below `D`; it explodes (correctly) far from
peg, which discourages depeg attacks.

## Fee architecture

| Parameter | Default | Cap |
| --- | --- | --- |
| `swapFeeBps` | 4 (0.04%) | 100 (1%) |
| `adminFeeBps` (% of swap fee) | 5_000 (50% of fee) | 10_000 |

Per swap:

```
gross_dy_xp                                    ← invariant solver output
fee_xp     = gross_dy_xp * swapFeeBps / 10_000
admin_xp   = fee_xp * adminFeeBps / 10_000     ← accumulator (NOT in reserves)
lp_xp      = fee_xp - admin_xp                 ← retained in reserves, grows LP value
dy_xp      = gross_dy_xp - fee_xp              ← user output
```

The admin slice accumulates in `adminFeeEtx` / `adminFeeStEtx` which
are excluded from the invariant. `claimAdminFees()` is permissionless:
anyone may sweep the accumulator into the owner-set `adminFeeRecipient`.

The non-admin slice stays in pool reserves, so every LP share's
underlying balance ratchets up on every swap. Treasury and public LPs
both benefit; the appreciation is unavoidable for the locked treasury
LP, but fees streaming **out** of the pool to the harvester are
unlocked and route to the treasury wallet immediately.

## 10/10/40/40 fee flywheel

`StableSwapHarvesterAdapter.harvest()` (permissionless) does:

1. Pull both legs from `pool.claimAdminFees()`.
2. Redeem any stETX leg for ETX via the vault (NAV-perfect, zero slippage).
3. Split the resulting ETX lump:

   | Slice | bps | Sink |
   | --- | --- | --- |
   | Staked-ETX yield | 1000 | `stETX.distributeRewards(amount)` |
   | Farms reward | 1000 | `ETXFarms.distributeRewards(amount)` |
   | POL burn | 4000 | Half-staked, paired into the pool, LP burned to `0xdEaD` |
   | Treasury | 4000 | Plain ETX transfer to `treasury` wallet |

Mirrors `TreasuryHarvester` exactly. The POL slice goes into **this**
stableswap pool (not ETX/wETI) for two reasons: the rate-aware curve
makes 50/50 pairing trivial (no swap leg required), and POL into a pool
with a 10-year-locked seed produces the strictest possible "permanent
depth" guarantee the project can offer.

If the staked or farms sink is not yet wired (`address(0)`), that
slice folds into the treasury slice for the run — no funds are stranded.

## 10-year treasury lock (treasury only)

`LiquidityTimelock10y` holds **only** the treasury's seed LP shares.
Mechanics:

- `unlockTime` is immutable, set to `block.timestamp + 365 days * 10`
  at construction.
- After deploy, the deployer calls `setLockedAmount(seedLp)` once. The
  pin is sticky: it can never be raised again, and can only be reduced
  by `lockedWithdraw` after `unlockTime`.
- `withdrawExcess(to, amount)` lets the owner pull any LP balance
  **above** `lockedAmount` at any time (e.g. accidental over-funding).
- `rescue(token, to, amount)` lets the owner sweep any **non-locked**
  ERC-20 — fee payouts, airdrops, governance tokens — at any time.
  Reverts if `token == lockedToken` so it cannot dodge the lock.
- `lockedWithdraw(to, amount)` reverts before `unlockTime`.

Public LPs interact with the pool directly. They hold their own LP
tokens and can `addLiquidity` / `removeLiquidity` / `removeLiquidityOneCoin`
at any time. The pool itself has zero notion of "locked" vs "unlocked"
holders — the timelock is just an EOA-shaped LP holder from the pool's
perspective.

## A-coefficient and ramping

Default `A = 200` at deploy (Curve-tight for a high-trust pair, will
ramp up over time once the pool proves out). Stored scaled by
`A_PRECISION = 100`, so internally `initialA = 20_000`.

Ramps obey:

- One ramp at a time; cannot start a new ramp within `MIN_RAMP_TIME`
  (1 day) of the previous.
- Ramp window must be at least `MIN_RAMP_TIME` long.
- Multiplicative change capped at `MAX_A_CHANGE = 10x` per ramp window.
- Hard ceiling `MAX_A = 1_000_000` (matches Curve).

`stopRampA()` freezes A at its current value if conditions warrant
emergency action. `getA()` returns the linearly-interpolated current
value.

## Initial seed (Phase 0 deploy)

| | Amount | Notes |
| --- | --- | --- |
| ETX seed | 15,000,000 ETX | 15% of 100M max supply |
| stETX seed | ~15,000,000 stETX | Mints from depositing 15M ETX into the vault at ~1.0 NAV |
| Total ETX commitment | ~30,000,000 ETX | 30% of max supply |
| Initial LP shares | ~30,000,000 esLP | Less the 1000-wei `MINIMUM_LIQUIDITY` lock |
| LP destination | `LiquidityTimelock10y` | Locked 10 years (principal only) |
| Fee recipient | `StableSwapHarvesterAdapter` | Routes 10/10/40/40 to existing flywheel |

The initial deposit must be NAV-balanced within 1% of xp-space. This
is stricter than V2 (which lets the first depositor pick any ratio) —
the rate-aware curve really needs to start at peg or the first swap
would be mispriced.

## Owner controls

The pool's `owner()` (treasury multisig, eventually behind a timelock)
can:

- `setSwapFee(uint16)` — capped at 100 bps (1%).
- `setAdminFee(uint16)` — capped at 10_000 bps (100% of fee).
- `setAdminFeeRecipient(address)` — non-zero only.
- `rampA(real, end)` — bounded by ramp pacing rules above.
- `stopRampA()` — freeze A at current value.

Owner cannot move user funds, cannot bypass the swap fee, cannot
withdraw locked LP from the timelock.

## Test coverage

`packages/contracts/test/stableswap/EticaStableSwap.t.sol` — 27 tests:

- Construction & metadata (3): name/symbol/decimals; revert on
  asset-mismatch; revert on zero A.
- Initial seeding (2): treasury seed mints expected LP into timelock;
  imbalanced first deposit reverts.
- Public-LP freedom (2): add/remove anytime, no lock; one-coin
  removal anytime.
- Swap math (2): near-zero slippage at peg for sizes well under D;
  output scales with NAV when rate drifts.
- Admin fees (2): accumulator increases on swap; `claimAdminFees`
  routes to recipient.
- A ramp (3): linear interpolation; reverts on max-change > 10x;
  reverts on too-short window.
- Owner controls (3): swap-fee cap, admin-fee cap, admin-recipient
  zero-revert.
- Timelock (5): unlocks at exactly 10 years; cannot move locked LP
  before; excess freely withdrawable; cannot rescue locked LP;
  cannot raise lock floor mid-life.
- Harvester adapter (4): 10/10/40/40 split routes; reverts when
  nothing to harvest; treasury LP stays locked across multiple
  harvest cycles; bps must sum to 10_000.

Run with `forge test --match-path 'test/stableswap/*'` from
`packages/contracts/`.

## Open items (next commits on this branch)

- `/deploy/stableswap-pool` browser deployer (auto-stake → seed → lock
  → wire harvester, single-flow UI).
- `/admin/stableswap` operator dashboard (view pool state, claim admin
  fees, ramp A, set fee parameters).
- `/swap` route integration: prefer EticaStableSwap for stETX↔ETX, fall
  back to V2 for everything else.
- Address registration in `apps/web/src/shared/addresses.ts` once
  deployed.

Beyond Phase 0, the same `_polBurnIntoPool` pattern is the template
for adding Phase 1 ETX/wETI concentrated liquidity (V3 fork or
custom) without changing the harvester contract.
