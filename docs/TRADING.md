# EticaHub Trading — Design Document

Status: **draft, pre-implementation.** This doc describes the architecture for non-custodial trading features (limit orders, stop orders, DCA, grid bots, infinite grid bots) on EticaHub v2. It is the spec that subsequent PRs implement.

## Goals

1. **Non-custodial.** EticaHub never holds user funds or signing keys. At every moment between signing an order and the fill landing on-chain, tokens live in the user's own wallet and are protected by the user's own key.
2. **No new auditable code on the critical path.** All on-chain components that touch funds are verbatim forks of contracts already audited by reputable firms (OpenZeppelin, Trail of Bits, ABDK). EticaHub's own code sits above them, stores signed orders, and renders UI — it never moves tokens.
3. **Grid + infinite-grid feasibility without a custodial bot.** The user can start a grid with one wallet interaction; the grid can run for days or weeks without the user's browser being open. This requires pre-signed batch orders, a public order book, and an open keeper network — not a server holding keys.
4. **Fee-free to start.** No treasury fee on fills in v1. We can add one later by routing orders through a thin fee-collector contract.
5. **Minimal ops surface.** EticaHub runs exactly one piece of always-on infrastructure (the order book API) and one best-effort process (a reference keeper). If both go down, existing on-chain orders are still cancellable directly at the contract.

## Non-goals (v1)

- On-chain order book. We use an off-chain order book (signed orders stored in Postgres) with on-chain fills. This is the same pattern used by 0x, 1inch Fusion, CowSwap, and UniswapX.
- Cross-chain trading.
- Leverage / margin / perps.
- Professional market-making tools (TWAP-with-impact-limits, ladder orders, iceberg orders). We'll revisit after v1 if there's demand.
- Copy-trading.

## High-level architecture

```
 ┌─────────────┐       sign (EIP-712)           ┌─────────────────┐
 │   User       │ ───────────────────────────▶  │  EticaHub UI     │
 │   wallet     │                               │  /trade/[token]  │
 └─────────────┘                                └──────────┬───────┘
        ▲                                                  │ POST signed order
        │ fills land in wallet                             ▼
        │                                            ┌────────────┐
        │                                            │ Order-book │
        │                                            │ API + DB   │
        │                                            └─────┬──────┘
        │                                     GET orders  │
        │                                                  ▼
        │                                          ┌─────────────┐
        │                                          │  Keeper(s)  │
        │                                          │  (anyone)   │
        │                                          └──────┬──────┘
        │                                                 │ execute
        │    ┌────────────────────────────────────────────┴────────┐
        │    │                     on-chain                          │
        │    │   ┌─────────┐   ┌─────────────┐   ┌────────────────┐ │
        └────┼──►│ Permit2 │──►│ EticaX       │──►│ EticaSwap V2   │ │
             │   │         │   │ Reactor     │   │ Router          │ │
             │   └─────────┘   └─────────────┘   └────────────────┘ │
             └──────────────────────────────────────────────────────┘
```

## On-chain components

### Permit2

We deploy Uniswap Labs' [Permit2](https://github.com/Uniswap/permit2) contract verbatim to Etica mainnet at the canonical address `0x000000000022D473030F116dDEE9F6B43aC78BA3`.

Permit2 lets users grant signature-based permissions to transfer their ERC20 tokens. Instead of the user calling `approve(EticaXReactor, amount)` once per token, the user approves `Permit2` once, and then **signs** off-chain permissions (with an amount, expiry, and nonce) every time they create an order. Those signatures live with the order; when a keeper fills, Permit2 verifies the signature and transfers tokens atomically into the Reactor.

Properties relevant to this design:
- Audited by OpenZeppelin, ABDK, and Trail of Bits (four independent audits).
- Stores no tokens — it's purely a gatekeeper.
- Permissions expire (`deadline` in the signed struct) and have per-user nonces so they can be cancelled on-chain if desired.
- Source is BSL-licensed with a "change-date" making it GPL/MIT-compatible after April 1, 2026. Fork usage for a non-competing protocol is explicitly permitted.

We deploy Permit2 at its canonical salt so that any wallet UX built around the canonical address "just works".

### EticaX Reactor

A verbatim fork of [UniswapX](https://github.com/Uniswap/UniswapX)'s `ExclusiveDutchOrderReactor`, minimally modified to:
- Point at our EticaSwap V2 Router instead of a v3/v4 UniversalRouter.
- Use WEGAZ as the wrapped-native token address (instead of WETH).
- Call the order-book for settlement-fee accounting (optional; disabled in v1).

An EticaX **order** is a signed EIP-712 struct containing:
- `maker`: user address
- `input`: (token, amount)
- `output`: (token, min-amount)
- `decayStartTime`, `decayEndTime`: price decays linearly between these to create a "Dutch auction" window the keeper can profitably fill inside
- `decayStartAmount`, `decayEndAmount`: the output decays from the favorable end to the limit end across the window
- `exclusiveFiller`: address(0) for "anyone can fill" or a keeper address for first-right-of-refusal
- `exclusivityEndTime`: if set, only `exclusiveFiller` can fill before this time
- `deadline`: past this, the order is invalid
- `nonce`: Permit2 nonce, used to cancel

The Reactor is what the keeper calls. Its job is to:
1. Verify the EIP-712 signature against the maker.
2. Compute the current price along the decay curve (at block.timestamp).
3. Pull `input` tokens from the user via Permit2.
4. Perform the swap through EticaSwap Router and verify `output` ≥ decayed target.
5. Transfer `output` to the maker.
6. Emit a `Fill` event.

**Why Dutch decay, not a flat limit?** Flat limits on a thin AMM are sandwich-prone: a searcher sees your order, front-runs the pool to put it at your exact limit, then back-runs after the fill. Dutch decay means the fill is only profitable for the keeper when the orderbook price has moved in the user's favor enough to cover the searcher's gas + their target margin, making sandwich attacks uneconomical for typical orders. The decay curve is chosen by the UI, not the user directly, based on pool depth.

For flat-limit-order UX (which users expect), we expose `decayStart == decayEnd == userLimit` and accept slightly worse fills. For grids we use wider decay curves.

### EticaSwap Router (existing)

No changes. The Reactor routes swaps through the existing `UniswapV2Router02` fork we already have deployed (`0xaefbf3fb975657a4c71ea0fb644b4afe5f555723`), using the hub-and-spoke paths through ETX.

## Off-chain components

### Order book API (`apps/orderbook`)

A new Node.js service. Thin by design:
- `POST /orders` — accepts a signed EticaX order, validates signature, stores in Postgres.
- `GET /orders?maker=...&status=open` — user's orders for UI.
- `GET /orders?token=...&side=...&status=open` — open orders on a market, served to keepers.
- `POST /orders/:hash/cancel` — accepts a signed cancel request (EIP-712) and marks the order cancelled in the DB.
- `GET /fills?maker=...` — fill history for a maker, read from `Fill` events via the indexer.

The API does **not** hold keys. Accepting an order is just ECDSA signature verification and a DB insert. Cancellation is purely a DB mutation — on-chain cancellation (via Permit2 nonce increment) is a separate, optional action the user can take in their wallet. In v1, "cancel" in the UI is an off-chain soft cancel: we stop serving the order to keepers, but until the deadline passes a keeper who obtained the order before cancellation can technically still fill. This matches 0x / 1inch semantics and is called out in the UI.

Deploys as a tiny Fly.io/Railway service + managed Postgres. ~$15/mo.

Open-source MIT-licensed so the user (or anyone) can self-host and submit orders to their own instance if EticaHub ever disappears.

### Reference keeper (`apps/keeper`)

A ~200-line TypeScript process. Responsibilities:
1. Subscribe to new orders from the order book API (polling `GET /orders` every 5s).
2. Subscribe to pair reserve updates from the RPC (polling `getReserves` every block).
3. For each open order, compute the decayed price at next-block timestamp and decide if filling is profitable (output tokens sold at spot price > input tokens cost + gas + target margin).
4. If profitable, simulate the fill, and if simulation passes, submit it.

EticaHub runs one. Open-source, dockerized, documented. Anyone who wants to capture fill profits can run their own. Multiple keepers on the same order are fine — exactly one wins (the one whose tx lands first), the others revert cheaply.

The reference keeper's signer wallet holds a small EGAZ balance for gas (tens of EGAZ). Nothing else. It does not hold user tokens. It does not need user keys.

### Price indexer (`apps/indexer` — extend existing)

Already have a basic indexer for research hub events. We extend it to:
- Subscribe to `Sync` events on EticaSwap V2 pairs.
- Persist `(pair, timestamp, reserve0, reserve1)` rows to Postgres.
- Serve `GET /price/:token?interval=1h|1d|7d|30d` for chart rendering.

## Front-end components

### `/trade/[token]`

Per-token trading page. Single-pair view (token quoted against ETX).

- **Header:** token symbol, price, 24h change, chart.
- **Market:** buy/sell tabs, market-buy and market-sell (calls the Router directly, no Reactor involved — same as `/swap` does today).
- **Limit:** buy/sell tabs, limit price, amount, expiry. Creates a Dutch-decay order with `decayStart == decayEnd == limit`.
- **Stop:** triggers a market order when a threshold is crossed. Implementation: a limit order with a large-enough decay window and a client-side scheduler that only submits the signed order once the trigger hits. (Alternative: a pure on-chain stop would require an oracle; we don't need that yet.)
- **DCA:** N orders, one per scheduled time, signed in a single wallet popup (multicall EIP-712). UI tracks fills, user can cancel remaining.
- **Grid:** wizard — user sets low/high bounds, N levels, bankroll per side. UI computes level prices, shows a preview, signs all 2N orders in one popup. As orders fill, UI optionally re-signs the opposite-side replacements.
- **Infinite grid:** same as bounded but with no upper bound. UI shows a rolling window of the next M sell orders above current price; as the bottom of the window fills, UI prompts for more signatures above.

### `/orders`

Global view of all of a user's open orders + fill history. Cancellation button per order.

## Order lifecycle

1. **Create.** UI builds the order struct, user signs in wallet, UI POSTs the signed struct to the order-book API.
2. **Distribute.** API serves `GET /orders` to keepers.
3. **Fill.** A keeper submits the order to the Reactor. Reactor pulls input via Permit2, swaps, pushes output to maker. `Fill` event indexed.
4. **Cancel (soft).** User clicks cancel. API marks order cancelled; stops serving it. A keeper that already pulled the order in-flight can technically still fill if the signature's deadline hasn't passed.
5. **Cancel (hard).** User submits a Permit2 nonce increment on-chain from the UI. From that moment, any fill with the old nonce reverts in Permit2. Costs gas.

## Trust model, in order of weakest to strongest

| What EticaHub does | Trust user must extend |
|---|---|
| Hosts the `/trade/[token]` UI | UI renders the correct order struct for them to sign; user can verify in their wallet |
| Stores signed orders | API can lose / refuse to show an order, but cannot forge a signature |
| Runs a reference keeper | Keeper can choose not to fill, but cannot extract more than the user signed for |
| Nothing else | — |

- **If EticaHub disappears**, all existing on-chain allowances and signed orders are still valid until expiry. Users can submit orders directly to the Reactor via eticascan. Other keepers can fill.
- **If the keeper disappears**, anyone else can start a keeper. Reference keeper source is in `apps/keeper`.
- **If Permit2 or the Reactor is buggy**, that's Uniswap Labs' bug, and the loss is the user's. We don't insure against upstream audit failures. Mitigation: verified source on eticascan, users can diff against the official Uniswap repos.

## What users must do

1. Once per token they want to trade, approve Permit2 as a spender of that ERC20. Equivalent to approving the Router on `/swap`. Gas: ~45k.
2. Per order / per batch, sign an EIP-712 message in their wallet. Free, signed locally.
3. Nothing else until a fill lands in their wallet.

## What we must do

1. Deploy Permit2 + EticaXReactor to mainnet (once).
2. Run the order-book API (always) and reference keeper (best-effort).
3. Pay the ~$15-30/mo hosting cost.
4. Keep the UI in sync with the contracts (once at deploy, rarely after).

## Rollout plan

| PR | Scope |
|---|---|
| A | This design doc |
| B | Vendor Permit2 + UniswapX Reactor source, Forge tests, deploy script |
| C | Deploy Permit2 + EticaXReactor to mainnet |
| D | Order-book API + reference keeper skeleton |
| E | Price indexer extension + `/trade/[token]` UI (limit + stop) |
| F | DCA + bounded grid + infinite grid wizards |
| G | Beta launch + docs |

Each PR is independently mergeable and functional — the site continues to work at every step.

## Open questions

1. **Treasury fee on fills.** Not in v1. If we want one in v2, we fork the Reactor once more and route a basis-point share of input to treasury before the swap. Adds ~30 LoC.
2. **"Legacy flat limit" without decay.** UniswapX removed pure-flat orders for sandwich reasons. Our UI will hide the decay from the user by default (show a "limit price" + a "patience" toggle that secretly sets decay width). Power users can opt into visible decay.
3. **Chart rendering library.** `lightweight-charts` vs `recharts`. Leaning `lightweight-charts` for candles + good perf on mobile.
4. **Order-book API language.** Node.js/TypeScript to share types + tooling with the rest of the monorepo, unless we hit perf issues.

## Appendix A — Upstream references

- [Permit2 repo](https://github.com/Uniswap/permit2)
- [Permit2 OpenZeppelin audit](https://blog.openzeppelin.com/permit2-audit)
- [Permit2 ABDK audit](https://github.com/Uniswap/permit2/blob/main/audits/ABDK.pdf)
- [Permit2 Trail of Bits audit](https://github.com/Uniswap/permit2/blob/main/audits/Trail%20of%20Bits.pdf)
- [UniswapX repo](https://github.com/Uniswap/UniswapX)
- [UniswapX OpenZeppelin audit](https://blog.openzeppelin.com/uniswap-x-audit)
- [UniswapX ABDK audit](https://github.com/Uniswap/UniswapX/blob/main/audit/v1.0.0/ABDK.pdf)

## Appendix B — Canonical addresses (post-deploy, to be filled in PR C)

| Contract | Address |
|---|---|
| Permit2 | _tbd_ |
| EticaXReactor | _tbd_ |
| EticaSwap Router (existing) | `0xaefbf3fb975657a4c71ea0fb644b4afe5f555723` |
| ETX (existing) | `0xa5a1bc6307b0b87989b8456d4b35f88a68650044` |
