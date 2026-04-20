# EticaHub Trading — Design Document

Status: **in progress.** PRs A (this doc, #28) and B (Permit2 vendoring, #29) are merged. PR C (UniswapX Reactor + ETX-denominated fee controller) is the current PR. This doc is kept live as the canonical spec for the whole trading stack; individual sections are marked with their PR status where relevant.

## Goals

1. **Non-custodial.** EticaHub never holds user funds or signing keys. At every moment between signing an order and the fill landing on-chain, tokens live in the user's own wallet and are protected by the user's own key.
2. **No new auditable code on the critical path.** All on-chain components that touch funds are verbatim forks of contracts already audited by reputable firms (OpenZeppelin, Trail of Bits, ABDK). EticaHub's own code sits above them, stores signed orders, and renders UI — it never moves tokens.
3. **Grid + infinite-grid feasibility without a custodial bot.** The user can start a grid with one wallet interaction; the grid can run for days or weeks without the user's browser being open. This requires pre-signed batch orders, a public order book, and an open keeper network — not a server holding keys.
4. **ETX-denominated protocol fee, disabled at launch.** Fee is pluggable via UniswapX's native `IProtocolFeeController` hook, denominated in ETX (since hub-and-spoke guarantees every trade has an ETX leg), capped at 1% on-chain, deployed at **0 BPS** so v1 runs fee-free. The reactor owner can flip the fee on at any time — same pattern as turning on the V2 pool-creation fee via `factory.setFeeTo`. No reactor fork required.
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

### DutchOrderReactor (verbatim UniswapX)

We deploy Uniswap Labs' [`DutchOrderReactor`](https://github.com/Uniswap/UniswapX) **verbatim** — bytecode is byte-identical to the upstream audited artifact, so OpenZeppelin / ABDK / Trail of Bits audits carry over unchanged. The reactor is chain-agnostic: it does not know about our Router, and does not need to. The keeper chooses the execution path when they fill.

This is simpler than what the earlier draft of this doc described (a modified fork with hardcoded WEGAZ / Router pointers) and has better audit-inheritance: no modification means no new attack surface.

An **order** is a signed EIP-712 `DutchOrder` struct (see [`DutchOrderLib.sol`](https://github.com/Uniswap/UniswapX/blob/main/src/lib/DutchOrderLib.sol)). Relevant fields:
- `info.swapper`: user address
- `info.deadline`: past this, the order is invalid
- `info.nonce`: Permit2 nonce, used to cancel
- `input`: (token, amount, maxAmount) with Dutch decay support
- `outputs[]`: each (token, startAmount, endAmount, recipient) — output decays across the window
- `decayStartTime`, `decayEndTime`: price decays linearly between these

When a keeper fills, the reactor:
1. Verifies the EIP-712 signature against the swapper via Permit2.
2. Computes the decayed amounts at `block.timestamp`.
3. Pulls input tokens from the swapper's wallet via Permit2.
4. Optionally asks `EticaProtocolFeeController.getFeeOutputs(order)` to append fee outputs (disabled in v1).
5. Invokes the keeper's `reactorCallback` (or direct `execute`) so the keeper can swap through **whatever** liquidity source they want (EticaSwap Router, on-chain aggregators, inventory, etc.) and deliver the outputs.
6. Transfers outputs (and fee) to the recipient(s) and emits `Fill`.

**Why Dutch decay, not a flat limit?** Flat limits on a thin AMM are sandwich-prone: a searcher sees your order, front-runs the pool to put it at your exact limit, then back-runs after the fill. Dutch decay means the fill is only profitable for the keeper when the orderbook price has moved in the user's favor enough to cover the searcher's gas + their target margin, making sandwich attacks uneconomical for typical orders. The decay curve is chosen by the UI, not the user directly, based on pool depth.

For flat-limit-order UX (which users expect), we expose `decayStart == decayEnd == userLimit` and accept slightly worse fills. For grids we use wider decay curves.

### EticaProtocolFeeController (our only original on-chain contract)

A ~120 LoC contract at [`packages/trading-contracts/src/EticaProtocolFeeController.sol`](../packages/trading-contracts/src/EticaProtocolFeeController.sol) that implements UniswapX's native `IProtocolFeeController`. Behavior:

- On every `getFeeOutputs(order)` call, checks whether the input or any output token is ETX; if so, returns a single `OutputToken{ token: ETX, amount: bps × legAmount / 10_000, recipient: treasury }`. If the order has no ETX leg (unreachable on EticaSwap since the factory enforces hub-and-spoke), returns an empty array.
- Owner can call `setFeeBps`, `setTreasury`, `setOwner`. Fee is **hard-capped at 100 BPS (1%) in the constructor and setter** — not an invariant the UI enforces, the contract itself.
- Deployed with `feeBps = 0` at launch. Owner flips it on later.
- Stores no tokens; no upgradeability; no surprise calls.

The reactor calls this controller inside `_injectFees`, so fee outputs are indistinguishable to the keeper from user outputs: the keeper must satisfy them atomically with the fill or the tx reverts.

### EticaSwap Router (existing)

Unchanged. Keepers swap through the existing `UniswapV2Router02` fork we already have deployed (`0xaefbf3fb975657a4c71ea0fb644b4afe5f555723`) using hub-and-spoke paths through ETX, but the reactor is agnostic to this choice — a keeper could use any liquidity source that lets them deliver the expected outputs.

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

| PR | Scope | Status |
|---|---|---|
| A | This design doc | merged (#28) |
| B | Vendor Permit2 as submodule + deploy wrapper | merged (#29) |
| C | Vendor UniswapX Reactor + ETX-denominated `EticaProtocolFeeController` + deploy scripts + deploy to Etica mainnet | this PR |
| D | Order-book API + reference keeper skeleton | pending |
| E | Price indexer extension + `/trade/[token]` UI (limit + stop) | pending |
| F | DCA + bounded grid + infinite grid wizards | pending |
| G | Beta launch + docs | pending |

Each PR is independently mergeable and functional — the site continues to work at every step.

## Open questions

1. **Fee-on at what BPS and when.** Launch fee is 0 BPS. Plan: leave at 0 through public beta (PR G). Once fill volume is steady and keepers are sustainable, flip to 5–10 BPS via `EticaProtocolFeeController.setFeeBps`. Revisit after ~1 month of fill data.
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

## Appendix B — Canonical addresses (post-deploy)

| Contract | Address | Source |
|---|---|---|
| Permit2 | _tbd_ (fill after `packages/contracts/script/deploy-permit2.sh` runs) | verbatim Uniswap Labs, commit `cc56ad0` |
| DutchOrderReactor | _tbd_ (fill after `packages/trading-contracts/script/deploy-trading-stack.sh` runs) | verbatim Uniswap Labs UniswapX |
| OrderQuoter | _tbd_ | verbatim Uniswap Labs UniswapX |
| EticaProtocolFeeController | _tbd_ | `packages/trading-contracts/src/EticaProtocolFeeController.sol` (this repo) |
| EticaSwap Router | `0xaefbf3fb975657a4c71ea0fb644b4afe5f555723` | existing |
| Factory | `0xfc8de5a5087c8825aa54e2c57b3ffe0e23784bc3` | existing |
| ETX | `0xa5a1bc6307b0b87989b8456d4b35f88a68650044` | existing |
| WEGAZ | `0x232fb2b87cace92b2438054a7eb79b4081e3e11a` | existing |
| Treasury | `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D` | existing |

### Deploy sequence

1. From `packages/contracts/`, run `script/deploy-permit2.sh` (deploys Permit2, outputs its address).
2. Set `PERMIT2_ADDRESS` + `ETX_ADDRESS` + `TREASURY_ADDRESS` + `REACTOR_OWNER` env vars.
3. From the repo root, run `packages/trading-contracts/script/deploy-trading-stack.sh` (deploys DutchOrderReactor, OrderQuoter, EticaProtocolFeeController; wires the fee controller onto the reactor with `feeBps = 0`).
4. Record all four addresses above.
5. Verify all four contracts on eticascan (Reactor + Quoter are verbatim UniswapX at solc 0.8.29, optimizer 1M; fee controller is at the same compiler flags; Permit2 is at solc 0.8.17 + via_ir).
