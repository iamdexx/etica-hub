# USDC → USDC.e bridge: security audit

Scope: the Hyperlane warp route (`infra/hyperlane/`), the in-repo fee contract
(`packages/contracts/src/bridge/WarpFlatLinearFee.sol`), the bridge-gas keeper
(`apps/keeper/src/bridge-gas/`) and the operational setup around them.
Hyperlane's own Mailbox / router / ISM contracts are upstream-audited and were
tested as deployed, not re-reviewed line by line.

Everything below was exercised on Anvil forks of Ethereum mainnet and Etica
mainnet with the real Hyperlane agents (`agents-v2.3.0`) relaying between them.
Nothing has been deployed to mainnet. Harness scripts are not part of the repo
(they hard-code fork addresses); results are quoted inline.

Trust model, stated plainly: the bridge is **automated, not trustless**. At
launch one validator (ours) attests to every message. Whoever holds that key
can mint unbacked USDC.e up to the Ethereum rate limit per 24h before the
guardian pauses the route. Everything else in this document is damage
containment around that fact.

## Findings

| # | Severity | Status | Title |
|---|----------|--------|-------|
| F-1 | High | fixed | Dust redemptions drain the relayer's ETH |
| F-2 | High | fixed | Keeper swap router / path were configurable from CI variables |
| F-3 | High | fixed | Treasury sweep destination was configurable from CI variables |
| F-4 | High | fixed | Keeper swaps were sandwichable in the public mempool |
| F-5 | Medium | fixed | Surplus could be swept while a gas top-up was blocked |
| F-6 | Medium | fixed | Unbounded ERC-20 allowance left on the swap router |
| F-7 | Medium | fixed | Relayer v2.2.0 could not deliver aggregation-ISM messages |
| F-8 | Medium | fixed | Fee-contract ownership / `feeRecipient` wiring in `deploy.sh` |
| F-9 | Medium | accepted at launch | Single validator |
| F-10 | Low | open | Gas-drop idempotency is balance-based |
| F-11 | Low | fixed | Malformed inbound recipients |
| F-12 | Info | documented | Collateral-side fee is charged on top of the amount |
| F-13 | Info | documented | Delivery resumes minutes, not seconds, after unpause |
| F-14 | Info | documented | Ethereum gas top-up waits for 200 USDC of fees |
| F-15 | Info | — | Static analysis results |

### F-1 Dust redemptions drain the relayer's ETH (High, fixed)
A pure 50 bps fee on Etica→Ethereum redemptions means a 1-unit (0.000001 USDC.e)
redemption pays 0 fee but still costs the relayer a ~200k-gas Ethereum
transaction. An attacker with a few USDC.e could burn the relayer's ETH faster
than fees replenish it and freeze the route.

Fix: Etica uses `WarpFlatLinearFee` — flat 2 USDC.e + 50 bps capped at 50 USDC
(`fee = flat + min(maxLinearFee, amount * maxLinearFee / (2 * halfAmount))`).
Parameters are immutable (constructor only). Ethereum keeps Hyperlane's pure
`LinearFee` (maxFee 50 USDC, halfAmount 5,000 USDC) because inbound delivery is
paid on Etica where gas is cheap.

Evidence (fork): 1 USDC.e redeem — user debited 3,005,000, fee contract
+2,005,000, supply −1,000,000; 1-unit redeem — user debited 2,000,001, fee
+2,000,000, supply −1. Quote parity with the Hyperlane contract at 1,000 USDC:
Hyperlane `LinearFee` → 5,000,000; `WarpFlatLinearFee` → 7,000,000, both via
`quoteTransferRemote(uint32,bytes32,uint256) → (address,uint256)[]`, so the
router-facing interface is the one Hyperlane's router actually calls (the
router on the fork charged exactly these amounts). 11 Foundry tests
(`test/bridge/WarpFlatLinearFee.t.sol`) cover the curve, cap, rounding, and
owner-only `claim`.

### F-2 Keeper swap router / path configurable (High, fixed)
`BRIDGE_GAS_<LEG>_ROUTER` / `_WRAPPED_NATIVE` were read from the environment.
Anyone who can set a GitHub Actions variable (or a compromised workflow) could
point every claimed fee at an attacker-controlled "router". Router,
wrapped-native and swap path are now constants in `config.ts`; the env keys are
ignored (unit test `pins the swap router, wrapped-native and path in code`).

### F-3 Treasury sweep destination configurable (High, fixed)
Same class of bug for `BRIDGE_GAS_TREASURY`. The sweep target is now the
`TREASURY_ADDRESS` constant from `@etica/shared`. Evidence (fork, live run with
`BRIDGE_GAS_TREASURY=<attacker>`): Ethereum sweep 763,816,728 and Etica sweep
85,996,856 both landed at `0xB2B4…C19D`; attacker balance stayed 0.

### F-4 Keeper swaps sandwichable (High, fixed)
The keeper converts fee USDC → ETH (Uniswap V2) and USDC.e → ETX → WEGAZ
(EticaSwap). A public-mempool swap with loose `amountOutMin` is free money for
a sandwich bot. Mitigations now in place:
* Ethereum writes go through Flashbots Protect (`https://rpc.flashbots.net/fast`)
  by default; reads stay on the configured RPC. Override only for forks.
* `amountOutMin` is derived from a fresh quote at the swap size with
  `maxSlippageBps` (default 150, hard ceiling 500 — config rejects more).
* Price impact is measured against a small probe quote; swaps whose impact
  exceeds the slippage budget are blocked rather than executed (thin
  liquidity / manipulated pool).
* Deadline is `now + 5 min` per transaction; the swap spends at most the
  wallet's stable balance; outputs are unwrapped to native in the same run.
Etica has no private relay; exposure there is bounded by the slippage cap and
the small swap sizes (tens of USDC.e).

### F-5 Sweep while top-up blocked (Medium, fixed)
If the swap was blocked (no quote, impact too high) the keeper would still
sweep surplus to the treasury, leaving the relayer under-fuelled. `sweepAmount`
now returns 0 whenever a needed swap is blocked.

### F-6 Unbounded allowance (Medium, fixed)
The keeper approves exactly `amountIn` immediately before each swap. A router
compromise can therefore take at most one swap's input, never the reserve.

### F-7 Relayer v2.2.0 vs aggregation ISM (Medium, fixed)
With the 3-module aggregation ISM on Ethereum, `agents-v2.2.0` logged
`Aggregation threshold not met (3)` / `InvalidDeliveredMessage` and never
delivered. `agents-v2.3.0` processes them (`Message successfully processed`,
collateral lock 5,000,000,000 → 4,998,999,999 after a 1-unit redemption).
`docker-compose.yml` default bumped; pin via `HYPERLANE_AGENT_TAG`.

### F-8 Fee-contract ownership and `feeRecipient` wiring (Medium, fixed)
`deploy.sh` deploys `WarpFlatLinearFee` with `owner = KEEPER` (not the
deployer) and token = the synthetic router address, which *is* the USDC.e
token on Etica (`HypERC20`). `setFeeRecipient` is owner-only on the router; the
script tries it from the deployer and otherwise prints the exact `cast send`
for the OWNER Safe. The keeper refuses to run a leg where it is not the fee
contract owner (`owns=false → claim=0`, observed on the fork before ownership
was transferred). Deploy script also rejects `OWNER == KEEPER`,
`OWNER == VALIDATOR`, `VALIDATOR == KEEPER`.

### F-9 Single validator (Medium, accepted at launch)
1-of-1 `messageIdMultisigIsm`. A compromised validator key + a relayer can
forge a "USDC locked" message and mint USDC.e; the Ethereum `rateLimitedIsm`
(51,840 USDC / 24h, refill 0.6 USDC/s) bounds what can be *released* before
the guardian pauses. Evidence (fork): forged body, altered nonce, replayed
message all rejected by the Mailbox/ISM; attacker `pause()`, `setRefillRate`,
`enrollRemoteRouter`, direct `mint`, direct `handle` all reverted; guardian
`pause()` stopped delivery (no mint after 120 s) and `unpause()` resumed it; a
1,000 USDC release was held by a 500 USDC cap and released after the cap was
restored (locked 5,098,999,999 → 4,098,999,999).
Required before meaningful TVL: ≥2-of-3 independent validators via
`hyperlane warp apply`; OWNER a Safe; validator key generated on and never
leaving its host; health check wired to the guardian pause.

### F-10 Gas-drop idempotency (Low, open)
Fresh recipients get 2 EGAZ once their inbound USDC.e (≥20) is observed via
`ReceivedTransferRemote` on the synthetic router, only if their EGAZ balance is
< 0.5 and only within the 600-block lookback (3-block reorg margin). A recipient
who spends below 0.5 EGAZ and bridges ≥20 USDC.e again gets another drop.
Cost to farm: ≥0.10 USDC fee + Ethereum gas per 2 EGAZ (cents), capped at 25
drops per run and by the keeper's native floor. Accepted; a persistent
processed-message store would close it fully. Evidence (fork): first run
`2 inbound, 1 to fund` → recipient exactly 2 EGAZ; second run `0 to fund`.

### F-11 Malformed recipients (Low, fixed)
`bytes32` recipients that are not zero-padded 20-byte addresses, the zero
address, and the keeper itself are skipped (unit tests).

### F-12 Collateral-side fee is on top (Info)
On Ethereum the router pulls `amount + fee` via `transferFrom`; an approval of
exactly `amount` reverts with `transfer amount exceeds allowance` (observed).
Any UI must approve `amount + quoteTransferRemote(...)`. Hyperlane's warp UI
does; the EticaHub bridge page only links out.

### F-13 Delivery after unpause (Info)
The relayer backs off on repeated `Pausable: paused` reverts; after unpause the
pending message landed ~4 minutes later, not immediately. Expected; document
in the runbook so a pause/unpause is not mistaken for a stuck route.

### F-14 Ethereum top-up threshold (Info)
The Ethereum leg only claims/swaps once ≥200 USDC has accrued (keeps claim +
swap overhead <~2 %). Until then the relayer runs on its launch buffer — fund
it to the 0.15 ETH target at launch, and expect the first top-up after ~40k
USDC of volume.

### F-15 Static analysis (Info)
Slither 0.11.6 over `packages/contracts/src` (lib/test/script excluded,
informational/optimization off): **0 findings in `WarpFlatLinearFee.sol`**.
All reported items are in `src/bridge/Bridge*`, `RateLimitISM`,
`FraudProverModule`, `FeeRouter` etc. — the earlier ETX bridge design, not
deployed (all zero addresses in `packages/shared/src/addresses.ts`) and not
part of this route. Foundry: 610 tests pass. Keeper: 23 unit tests pass,
typecheck clean.

## Not covered
* Hyperlane core contract internals (upstream audits apply).
* Real-mainnet MEV behaviour of the Etica swap (no private relay exists on
  Etica; mitigated by slippage/impact caps only).
* Validator key compromise beyond what the rate limit bounds.
* RPC/log provider truncation on mainnet (forks return complete logs); the
  keeper fails closed — a failed scan skips drops for that run.

## Mainnet blockers (in order)
1. OWNER = Safe; GUARDIAN, KEEPER, VALIDATOR distinct keys; validator key
   generated on its host.
2. Paid Ethereum RPC with full `eth_getLogs` for the relayer and keeper.
3. Fund KEEPER to targets (0.15 ETH, 60 EGAZ) and VALIDATOR with dust ETH.
4. `deploy.sh all`, then confirm on-chain: `feeRecipient()` on both routers,
   `owner()` of both fee contracts == KEEPER, ISM module lists/thresholds
   (Ethereum 3-of-3 aggregation, Etica 2-of-2), rate-limit capacity.
5. Seed the USDC.e/ETX pool (10,000 ETX pair-creation fee) so the Etica
   top-up has liquidity.
6. Bridge-gas workflow dry run against mainnet, then live.
7. Publish "automated, single-validator at launch" wording on the bridge page.
8. Add validators and raise the threshold before TVL grows.
