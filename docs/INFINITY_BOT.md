# The Infinity Bot — Design Document

**Status:** shipped in v1 trading stack. This document is the canonical spec.
**Scope:** the "Infinite grid" mode on `/trade/[token]`, implemented by
`buildInfiniteGridLegs` (`apps/web/src/lib/trading/dutchOrder.ts`) and the
`InfiniteGridForm` component (`apps/web/src/components/trade/InfiniteGridForm.tsx`).

## 1. What it is

The Infinity Bot is a non-custodial, self-replenishing limit-order grid that
sits around a user-chosen reference price with **geometric** (percent-based)
spacing rather than linear spacing. It extends indefinitely on both sides of
the reference: there is no fixed upper or lower bound — only a per-batch cap
on how many levels the user is willing to pre-sign at once.

It is the sixth trading mode on EticaHub, sitting on top of:

| Mode | Shape | Best for |
|---|---|---|
| Market | one-shot AMM swap | immediate execution |
| Limit | one-shot at a price | "I will buy at N" |
| Stop | one-shot triggered | "sell if price drops to N" |
| DCA | schedule of one-shot buys | "buy 10 ETI/week for 8 weeks" |
| Grid (bounded) | N buy + N sell between a low/high | "range-trade inside $X–$Y" |
| **Infinite grid** | N buy below + M sell above, geometrically spaced | "range-trade forever, regardless of where price goes next" |

## 2. Why it exists

A bounded grid dies when price walks past the user's chosen bounds. The user
wakes up, sees the grid is out of range, cancels what's left, and re-signs a
new grid. For a chain whose price can drift orders of magnitude over a year
(Etica is that chain), this is enough friction that the user just doesn't
bother — the bot sits dead.

The Infinity Bot's contract with the user is different:

> Sign one batch. When price walks past the top or bottom of your window,
> sign one more batch. Each batch is as big or small as you like. The grid
> never structurally dies — only your current pre-signed levels run out.

Crucially, **no new on-chain code is needed for this**. The infinity-grid
semantics are purely a *client-side strategy for generating* a batch of
standard UniswapX-style Dutch limit orders. Every order in the batch is a
regular pre-signed order that our existing Reactor + keeper already know
how to fill.

## 3. Non-custodial guarantees

Same as every other trading mode:

- **The user's key stays in the user's wallet.** EticaHub never signs on
  their behalf and never holds custody of tokens.
- **Signatures authorize a finite, user-visible budget.** Each level has
  its own signature, its own nonce, and its own deadline. Filling a level
  is atomic via Permit2; there is no ambient allowance to drain.
- **Cancellation is unilateral.** The user can cancel soft (UI → order
  book drop) or hard (on-chain Permit2 nonce increment, reverts the
  signature forever). Both are documented in `TRADING.md`.

## 4. Math

Given a reference price `R`, a step `p` expressed as a fraction (e.g. 0.02
for 2%), a buy-side count `n_b`, and a sell-side count `n_s`:

```
Buy levels  : B_k = R · (1 - p)^k  for k = 1 … n_b   (k=1 is the nearest buy)
Sell levels : S_k = R · (1 + p)^k  for k = 1 … n_s   (k=1 is the nearest sell)
```

The buy series is emitted **lowest first** so that level index 0 is always
the furthest-below price. The sell series is emitted **nearest first** so
that the first sell level sits just above the reference. This gives a
single contiguous ascending array `B_{n_b} → B_1 → S_1 → S_{n_s}` which
maps cleanly onto the keeper's expected `gridIndex` ordering.

### Why geometric, not arithmetic

Percent-based spacing has two properties that arithmetic spacing lacks:

1. **Scale invariance.** A 2% step feels the same whether the token is
   trading at $0.01 or $100. Arithmetic spacing requires the user to
   retune the step every time price moves a decade.
2. **Bounded ruin.** No matter how far price walks in either direction,
   the buy levels asymptote to zero from above and the sell levels
   increase unboundedly. There is no "price at which the grid becomes
   absurd" — every level is always a sensible proportion of its
   neighbors.

### Built-in ceilings

- **Per-batch level cap: 50.** Wallet UX degrades sharply past ~30
  signatures in one popup; 50 is the practical ceiling. The user can
  always sign a second batch.
- **Step ceiling: < 50%.** Geometric progressions with `p ≥ 50%`
  collapse to zero (for buys) or diverge (for sells) within a handful
  of levels. We reject the batch client-side before signing.
- **Batch validity: 7 days.** Same window as the bounded grid. Long
  enough to catch realistic cycles, short enough to keep signed
  liabilities manageable.

## 5. User flow

1. User lands on `/trade/ETI` or `/trade/EGAZ`, picks the **Infinite**
   tab.
2. User fills in: reference price `R`, step % `p`, buy levels `n_b`,
   sell levels `n_s`, base amount per level.
3. UI calls `buildInfiniteGridLegs` which produces the array of
   `GridLevel` structs, with a shared `gridBatchId` tagging all levels
   as one batch.
4. UI previews the plan: lowest buy price, highest sell price, total
   ETX committed (sum across buy levels), total base committed (equal
   to `sellLevels × baseAmountPerLevel`), number of signatures.
5. User approves Permit2 once per token (if not already approved).
6. User signs the batch in one wallet popup. Each level is a standard
   Permit2-witnessed Dutch limit order; only the `nonce` differs per
   level.
7. The order book stores the batch and serves it to keepers.
8. As price moves, the keeper fills whichever level is in-the-money.
   The order book keeps the remaining levels available.
9. When price walks past the top or bottom of the window, the user
   signs a new batch recentred on the new price. The old batch's
   remaining levels continue to be valid until their 7-day deadline
   expires.

## 6. Re-signing policy

The client intentionally does **not** auto-sign new batches when price
walks out of range. Three reasons:

1. **Consent.** Every new batch commits additional user funds. That
   requires a fresh, explicit signature in the user's wallet — not a
   "set and forget" auto-re-sign that the user can't see.
2. **No silent drift.** If the user wanted a different reference
   price, or a different step, or a pause, they'd never discover that
   until they came back. Manual re-sign forces them to look at the
   current price and approve.
3. **Simpler trust model.** Auto-re-signing would require the client
   (or a server) to hold some form of persistent authorization. We
   don't have that, and we don't want it.

The UI *does* prompt the user with a one-click "sign next batch"
affordance when it detects price has crossed their outermost level,
so the friction is low — but the signature is always explicit.

## 7. Risks

| Risk | Mitigation |
|---|---|
| User loses track of how many batches they've signed and over-commits funds | UI shows all open batches on `/trade/orders`; hard cancel available per batch |
| Price gaps through multiple levels in one block, filling more than the user expected in a given direction | Per-level nonces + Permit2 expiries; total commitment is bounded by `(n_b + n_s) × baseAmountPerLevel` at sign time |
| Keeper downtime during a fast move | Multiple keepers can fill in parallel; reference keeper is open-source; users can self-fill directly via eticascan |
| Grid math bug | Covered by 13 unit tests: ordering, asymmetric layouts, contiguous indices, validation (zero ref, zero step, ≥50% step, total 0/>50 levels, zero base, short deadline) |
| User signs with a reference price stale from a previous session | Preview re-derives range/ETX/base on every input change; user sees exact commitment before signing |

## 8. What is NOT implemented (deliberately)

- **Dynamic bankroll management.** Every level has the same
  `baseAmountPerLevel`. More sophisticated bots allocate more capital
  to levels closer to the reference; we don't. Users who want that can
  sign several overlapping batches.
- **Auto-rebalance on fill.** Some grid bots automatically sign a
  replacement order on the opposite side when a fill lands. We don't —
  see §6 on why explicit consent matters.
- **Server-side grid state.** The order book is a dumb store of
  signed orders. It doesn't know what a "grid" is; it just sees 20
  limit orders tagged with the same `gridBatchId`. No orchestration
  state lives server-side.
- **Cross-pair grids.** One grid = one base token against ETX. Users
  wanting exposure across several pairs sign several grids.

## 9. Code layout

| Path | Purpose |
|---|---|
| `apps/web/src/lib/trading/dutchOrder.ts` → `buildInfiniteGridLegs` | Pure builder. Generates the ordered `GridLevel[]`. No I/O, no wallet, no network. |
| `apps/web/src/components/trade/InfiniteGridForm.tsx` | The `/trade/[token]` tab. Approvals, preview, signing loop, submission. |
| `apps/web/src/components/trade/TradeTabs.tsx` | Registers the `Infinite` tab next to `Grid`. |
| `apps/web/test/dutchOrder.test.ts` | 13 unit tests for `buildInfiniteGridLegs`. |

## 10. Why "Infinity Bot"

Because "geometrically-spaced unbounded two-sided limit-order grid
with per-batch pre-signing" doesn't fit on a home page card.
