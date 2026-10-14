# EticaSwap Direct — stETX-gated direct pairs

EticaSwap V2 is hub-and-spoke: every pair contains ETX, so all public liquidity routes through the hub. Aggregators (GeckoTerminal, DefiLlama) price a token only from a pool against a stable they recognise, so EGAZ and ETI, which only trade against ETX, show no USD price.

EticaSwap Direct is a second, smaller venue that resolves this without weakening the hub:

- `EticaDirectFactory` hosts **curated** direct pairs (EGAZ/USDC.e, ETI/USDC.e). Only the treasury (or a trusted creator) can open a pair; no ETX requirement, no creation fee.
- `EticaDirectPair` is `EticaSwapPair` with one check: the `to` recipient of every mint, burn and swap must pass `factory.isAllowed(to)` — hold at least `minStEtx` stETX, or be a venue pair / whitelisted router. Events, `getReserves`, `getPair`, `allPairs` are V2-compatible so indexers and routers work unchanged.
- `EticaDirectRouter` is `EticaSwapRouter` plus the same gate on `to` in every entry point (the pair only sees the router as `to` on EGAZ-unwrap paths, so the router has to enforce it too).
- `DirectSwapHarvesterAdapter` is the factory `feeTo`: 1/6 of the tiered swap fee (LPs keep the other 5/6) accrues as LP, the keeper burns it, swaps each leg to ETX on the hub router and splits the ETX exactly like the V2 TreasuryHarvester: 10% `stETX.distributeRewards`, 10% farms, 40% POL bought back into the direct pair with the LP burned to the dead address, 40% treasury.

Why this keeps the fundamentals: using a direct route requires holding stETX, i.e. staked ETX, so direct flow still creates ETX demand, and the venue's fees are paid to ETX stakers. The public DEX, token picker and default routing remain hub-only; the direct venue is an unlock for stakers.

Deployment (not yet done): deploy factory (feeToSetter = treasury, `minStEtx` e.g. 1,000 stETX), router, adapter; `setWhitelist(router)`, `setWhitelist(adapter)`, `setFeeTo(adapter)`; `createPair(WEGAZ, USDC.e)` and `createPair(ETI, USDC.e)`; seed via the router from a staker wallet; register the factory with GeckoTerminal as a V2-style DEX; wire the keeper to call `adapter.harvest` with hub quotes as `minEtxOut`. Addresses live in `packages/shared/src/addresses.ts` (`directFactory`, `directRouter`, `directHarvesterAdapter`).

## Curation rules

- Only open a direct pair when both tokens already have an ETX pool on the public hub: the harvester sells each fee leg to ETX through the hub router (and buys the POL slice back the same way), so a pair with a hub-less token accrues fees that cannot be harvested until that hub pool exists.
- Pairs are opened by the treasury (`feeToSetter`) or a trusted creator only; `router.addLiquidity*` on an unopened pair reverts `EDirect: NO_PAIR`.

## Swap fee tiers (stETX balance of the trader)

The venue fee is not flat: `EticaDirectFactory.feeBpsFor(trader)` returns the fee in basis points from a ladder set by `feeToSetter` (`setFeeTiers`, `setBaseFeeBps`, cap 10%). Launch ladder:

| stETX held | fee |
|-----------:|----:|
| < 40,000 | blocked (`minStEtx`) |
| 40,000 | 3.00% |
| 100,000 | 1.50% |
| 250,000 | 0.50% |
| 500,000+ | 0.10% |

The pair prices `swap(to)` at the recipient's tier; the router uses `swapFor(..., trader)` (whitelisted callers only) so EGAZ unwrap hops and multi-hop intermediates are priced at the tier of the wallet that initiated the trade, never at the router's or a pair's. Quotes: `router.getAmountsOut(amountIn, path, trader)`; the two-argument V2 form prices for `msg.sender` (`eth_call` `from`).
