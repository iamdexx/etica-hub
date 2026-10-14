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

The pair prices a direct `swap(to)` at the recipient's tier. The router prices every swap at its `msg.sender` (the wallet signing the trade, which must itself pass the gate) via `swapFor(..., trader)` — whitelisted callers only — so EGAZ unwrap hops and multi-hop intermediates are charged to the signer, never to the router, a pair or a recipient who did not consent. Quotes: the two-argument V2 `getAmountsOut`/`getAmountsIn` price for `msg.sender` (`eth_call` `from`) exactly as the swap will charge; `getAmountsOut(amountIn, path, trader)` quotes for another wallet.

## Deploying (`/deploy/direct`)

Two pages. **`/deploy/direct`** (operator, treasury wallet) deploys and configures the venue, one
signature per step: factory (gate 40,000 stETX, `feeToSetter` = treasury) → `EticaDirectMetaPairDeployer`
→ router → harvester adapter → `setMetaPairDeployer` → whitelist router / harvester / seeder →
`setFeeTo(harvester)` → `setFeeTiers` (40k 3.00%, 100k 1.50%, 250k 0.50%, 500k+ 0.10%) →
`harvester.setTreasuryToken(USDC.e)` → `createMetaPair(WEGAZ, USDC.e, hubRouter)` and
`createMetaPair(ETI, USDC.e, hubRouter)` → `setGuardian` (optional, the watcher's pause-only key).
A final hand-off group deploys the 2-of-2 `UnanimousMultisig` (treasury + second signer) and runs
`setFeeToSetter(multisig)` + `harvester.transferOwnership(multisig)`; do it after seeding and
checking the venue, since every later admin change then needs both signatures.

**`/deploy/direct/seed?factory=0x…`** (seeder, the whitelisted wallet) signs seven prefilled txs:
`WEGAZ.deposit`, then per window a plain `transfer` of 10 USDC.e and of the EGAZ / ETI worth $10 at
the hub *spot* price (reserves of USDC.e/ETX × ETX/WEGAZ|ETI) into the window followed by
`mint(0x…dEaD)`. The window turns each leg into token/ETX hub LP it can never withdraw; the shares at
the dead address are accounting only. Between a transfer and its mint the tokens sit on the window;
the only thing anyone else can do with them is `skim` to the fee sink (the harvester, owner-rescuable),
so send and mint back to back. Setup state (deployer, whitelists, feeTo, tiers, treasury token,
windows, guardian, setter, harvester owner, window balances / hub LP) is re-read from chain, so a
reload or a second browser resumes where things actually are. Afterwards paste the five addresses into
`packages/shared/src/addresses.ts` (`directFactory`, `directMetaPairDeployer`, `directRouter`,
`directHarvesterAdapter`, `directAdmin`), fill `apps/direct-watcher/expected.json`, and add the
keeper with `harvester.setKeeper(keeper, true)` (through the multisig once handed off).

Artifacts come from `node packages/contracts/script/extract-direct-artifacts.mjs` (after
`forge build`), which writes `apps/web/src/lib/direct-deploy-artifacts.json`.

## Hub metapairs (windows over the hub)

A plain direct pair holds its own EGAZ and USDC.e, which is a spoke-to-spoke bypass of the hub. `EticaDirectMetaPair` removes that: it is a pair-shaped contract for `token0`/`token1` (opened with `factory.createMetaPair(tokenA, tokenB, hubRouter)` after `setMetaPairDeployer(EticaDirectMetaPairDeployer)` — the creation code lives in a separate stateless deployer to keep the factory under the EIP-170 size cap; same registry and `PairCreated` event as `createPair`) whose only holdings are LP of the two **public V2 hub pools** `token0`/ETX and `token1`/ETX.

- **Deposits deepen the hub.** `mint(to)` takes whatever `token0`, `token1` (and loose ETX) sit on the contract, swaps half of each to ETX on the hub, adds each leg to its hub pool and keeps the hub LP. Rounding dust is donated to the hub pool so the window never holds raw tokens between transactions. Only the venue owner or a whitelisted contract (harvester, seeder) can call `mint`: windows are protocol-owned liquidity, there are no outside LPs. Shares are minted to `to` for accounting only; `burn` always reverts — the hub LP can never leave.
- **Reserves are real and priced by the hub.** The window is worth `2·(e0+e1)` ETX (each hub LP position is half token, half ETX, equal at spot). `getReserves` reports half of that value in `token0` at the `token0`/ETX spot and half in `token1` at the `token1`/ETX spot, so `r1/r0` is exactly the hub cross price and `r0 + r1` is the window's TVL. `sync()` is permissionless so a keeper can republish after hub trades. Aggregators that sum TVL across pools will count this capital twice (hub pool + window); label it.
- **Swaps settle on the hub.** `swap(amount0Out xor amount1Out, to, "")` (V2 pre-pay style), `swapFor(..., trader)` (whitelisted routers) and `swapExactIn(tokenIn, amountIn, minOut, to, deadline)` (wallets) all: take the trader's stETX tier fee from the input and forward it **in kind** to `feeTo`, swap the rest on the hub `tokenIn → ETX → tokenOut` with the requested output as min-out, and send the full hub output to `to`. The reported reserves are never an input to settlement, so manipulating them yields nothing. Flash swaps are refused. Quote with `quoteOut(tokenIn, amountIn, trader)` — a constant-product quote off `getReserves` is wrong for a window because trades hit the whole hub, not the window.
- **Fees** reach `DirectSwapHarvesterAdapter` as raw tokens; `harvest` sells them to ETX and splits 10/10/40/40 as usual; the 40% POL slice is sent back through the window (`mint`) into the hub pools and the 40% treasury slice is paid in `treasuryToken` (USDC.e) when the owner has set one, otherwise in ETX. Legs too small to buy any ETX are skipped and carried to the next run instead of reverting.
- Windows exclude ETX as a leg (ETX pairs are hub pools already) and require both hub pools to exist. `EticaDirectRouter` does not route through windows yet; use the window's own entry points.

### Audit notes (window pass)

- The raw `swap(amount0Out, amount1Out, to, data)` entry point on both pair kinds gates **the caller** and charges the caller's tier; `to` is only checked as a recipient. Routers price a named trader through `swapFor`.
- `DirectSwapHarvesterAdapter`: a treasury slice too small to buy any `treasuryToken` is paid in ETX; windows listed in a harvest always receive an equal POL share even when a sibling window sold the shared fee token first.

### Guardian, pause and retire

- `factory.setGuardian(addr)` names a key that can call `pauseSwaps()` and nothing else; `unpauseSwaps()` is `feeToSetter` only. Every swap entry point on pairs and windows checks `factory.swapsOpen(pair)` and reverts `EDirect: PAUSED`. Deposits, `skim`, `sync` and fee harvesting keep working while paused, so a pause can never trap funds.
- `factory.retirePair(pair)` turns a pair's swaps off for good, clears `getPair` for its tokens so a fixed replacement can be opened with `createPair`/`createMetaPair`, and keeps `isPair`/`isMetaPair` so the harvester still collects fees already forwarded. A retired window's hub LP stays in the public hub pools (deepening them); it just stops being attributed to a venue pair.
- `apps/direct-watcher` (cron every 5 min) checks hub LP monotonicity, admin settings against `expected.json`, reported price vs the hub cross price, large swaps and loose tokens; alerts to Telegram and auto-pauses on a critical finding when it holds the guardian key. Runbook: after deploy, fill `apps/direct-watcher/expected.json`, set the `DIRECT_FACTORY_ADDRESS` variable and the `DIRECT_GUARDIAN_PRIVATE_KEY` secret (a fresh EOA you then pass to `setGuardian`), and dispatch the workflow once.

### Admin key: 2-of-2 multisig

`packages/contracts/src/governance/UnanimousMultisig.sol` is a minimal N-of-N multisig (owners fixed at construction; `propose` counts as the proposer's confirmation, the last `confirm` executes, any owner can `cancel`, a failed call keeps the proposal open). Launch recipe: deploy the venue from the treasury wallet, then `new UnanimousMultisig([treasury, 0x98d057B8fD9eA2256CbaeDc2d33A5e59af9c2051])`, `factory.setFeeToSetter(multisig)` and `harvester.transferOwnership(multisig)`. From then on tiers, whitelist, deployer, treasury token, `unpauseSwaps` and `retirePair`/`createMetaPair` ("upgrades") need both signatures; one "no" means no change. Caveat: with 2-of-2, losing either key freezes admin for good (no unpause, no tier changes); rotate by deploying a new multisig and handing the roles over through the old one.

