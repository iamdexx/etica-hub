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
| F-3 | High | fixed | Surplus destination was configurable from CI variables |
| F-4 | High | fixed | Keeper swaps were sandwichable in the public mempool |
| F-5 | Medium | fixed | Surplus could be released while a gas top-up was blocked |
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
| F-17 | Medium | fixed | Ethereum self-bridge misread the warp quote and never released surplus |
| F-18 | Medium | fixed | Validator trusted a single RPC for the state it signs; keeper/relayer had no RPC failover |

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
router on the fork charged exactly these amounts). 6 Foundry tests
(`test/bridge/WarpFlatLinearFee.t.sol`) cover the curve, cap, rounding, and
owner-only `claim`.

### F-2 Keeper swap router / path configurable (High, fixed)
`BRIDGE_GAS_<LEG>_ROUTER` / `_WRAPPED_NATIVE` were read from the environment.
Anyone who can set a GitHub Actions variable (or a compromised workflow) could
point every claimed fee at an attacker-controlled "router". Router,
wrapped-native and swap path are now constants in `config.ts`; the env keys are
ignored (unit test `pins the swap router, wrapped-native and path in code`).

### F-3 Surplus destination configurable (High, fixed)
Same class of bug for `BRIDGE_GAS_TREASURY`: the first hardening pass pinned
the sweep to the `TREASURY_ADDRESS` constant (fork evidence: with
`BRIDGE_GAS_TREASURY=<attacker>` the Ethereum sweep 763,816,728 and Etica
sweep 85,996,856 both landed at `0xB2B4…C19D`, attacker balance 0).

The surplus now never leaves the keeper — it is swapped into EGAZ that
stays in the keeper wallet (see F-16), so there is no destination address
left to redirect. `BRIDGE_GAS_TREASURY` is ignored and
the config has no `treasury` field (unit test `pins the surplus
destinations`).

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

### F-5 Surplus released while top-up blocked (Medium, fixed)
If the swap was blocked (no quote, impact too high) the keeper would still
release the surplus, leaving the relayer under-fuelled. `surplusAmount` now
returns 0 whenever a needed swap is blocked, so gas always comes first.

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
(5,000 USDC / 24h at launch, refill ~0.0579 USDC/s) bounds what can be *released* before
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

### F-16 Surplus becomes keeper EGAZ; Ethereum leg bridges to self (Design)
Bridge fees above the keeper's 500-stable reserve are turned into EGAZ for
the keeper (owner's decision: the gas pile grows without a cap instead of
being burned as POL): on Etica the USDC.e surplus is swapped along the
pinned `USDC.e → ETX → WEGAZ` path and unwrapped, at most
`BRIDGE_GAS_ETICA_MAX_SURPLUS_SWAP` (250 USDC.e) per run, halving the chunk
while the price-impact ceiling is exceeded. On Ethereum the surplus USDC is
sent with `transferRemote(61803, keeper, amount)` to the keeper's **own**
Etica address, so it arrives as USDC.e and is swapped on the next Etica run.
Properties relied on:
* Fee revenue only ever accrues in the keeper wallet; no env var names a
  recipient, so the keeper key (or a CI-variable attacker) can at most hold
  stable instead of swapping it, never move it elsewhere. The swap path is
  pinned (F-2) and `to` is always the keeper itself.
* The surplus swap is bounded by the same `maxSlippageBps` price-impact
  check as the gas swap (one-unit probe vs. the chunk's `getAmountsOut`),
  carries `amountOutMin` with slippage and a 5-minute deadline, and is
  capped per run. A thin or manipulated pool makes the keeper *hold* the
  stable (or swap a smaller chunk), never dump it.
* The Ethereum collateral router named by `BRIDGE_GAS_ETHEREUM_WARP_ROUTER`
  is verified before every send: `wrappedToken() == USDC`, `mailbox() ==`
  the canonical Ethereum Mailbox pinned in code (`ETHEREUM_MAILBOX`;
  overridable only when the RPC is a loopback fork, unit-tested), `routers
  (61803) == bytes32(USDC.e)` and `feeRecipient() == BRIDGE_ETHEREUM_FEE_CONTRACT`.
  A poisoned variable pointing at a look-alike router therefore reverts the
  leg instead of handing it the USDC. The approval is exact (`amount + fee`)
  and the recipient is the keeper itself, so even a bug here cannot pay a
  third party.
* Bridging the surplus pays the route's own fee (recovered by the Ethereum
  fee contract on the next claim) and the IGP gas quote; the leg refuses to
  bridge if that would push the keeper's ETH under `MIN_NATIVE`.
* User principal is never involved: only balances already claimed from the
  fee contracts into the keeper wallet are touched.

### F-17 Self-bridge misread the warp quote (Medium, fixed)
`quoteTransferRemote` returns the stable leg as `amount + fee` (the total the
router pulls), not the fee. The Ethereum leg treated it as the fee, so every
surplus was held with `surplus 30000000 does not cover the bridge fee
30150000` and the Ethereum half of the POL loop silently never ran. Fixed:
fee = quoted total − amount (reverts if the quote is below the amount); the
exact approval is the quoted total. Fork evidence (same run as F-16):
`approve 29999250`, `bridge 29850000 USDC -> keeper on Etica (fee 149250)`,
collateral lock 15,200,000,000 → 15,229,850,000, keeper USDC 35,000,000 →
5,000,750 (5 USDC test float kept), USDC.e on the keeper's Etica address
4,969,893 → 34,819,893 after relayer delivery.

### Fork evidence for the full fee → gas → float → POL loop
Local Ethereum + Etica forks, real validator/relayer (`agents-v2.3.0`), 5 USDC
test floats, Etica gas floor/target 20/25 EGAZ, Ethereum 0.05/0.06 ETH:
* Ethereum, fees 30.5 USDC, ETH 0.049: `claim 30500000` → Uniswap swap →
  `unwrap 11825096825635584` → ETH 0.0606. All fees went to gas because the
  gas deficit exceeded them; float 0, nothing bridged (gas before POL).
* Ethereum, next run, fees 35 USDC, gas above floor: claim, keep 5 USDC,
  bridge 29.85 USDC to self (F-17).
* Etica, 34.819893 USDC.e, EGAZ 10 (< 20): `swap 30116 stable` →
  `unwrap 15000408342133709921` → EGAZ 25.0; float exactly 5,000,000 kept;
  surplus 29,789,777 → `POL swap 14894888 stable -> ETX` (4,893.3 ETX) →
  `addLiquidity(ETX 4893315522696975350908, USDC.e 14894889)`; the pair
  (`factory.getPair(USDC.e, ETX)` = `0x4e91…CbFa`) emitted `Transfer(0x0 →
  0x…dEaD, 268412762060614)`; keeper LP balance 0. The same tx also minted
  67,379,195,469 LP to the factory's `feeTo` (the treasury): that is
  EticaSwap's own protocol-fee mint on liquidity events, not a keeper payment.
* Outbound: a 4,000 USDC.e redemption was delivered by the relayer
  (collateral 12,200 → 8,200 USDC) only after the agent tag bump (F-7).
* Gas drop: recipient B received exactly 2 EGAZ on the first run; the second
  run logged `0 to fund` (F-10 evidence).
* Treasury wallet USDC/USDC.e unchanged (0) throughout; user principal
  untouched (locked == USDC.e supply at every check).

### F-18 Single-RPC trust in the validator; no read failover (Medium, fixed)
The agents and the keeper each took one Ethereum RPC. For the relayer and
keeper that is a liveness issue only — every read is checked against the
chain (fee-contract owner, router bindings, mailbox) or enforced by the ISM
on delivery — but the validator signs the mailbox root its RPC reports, so
one dishonest endpoint could have had it attest to a fabricated lock and
the relayer would then mint unbacked USDC.e (bounded by the 5k/day cap).
Fix: validators run `rpcConsensusType=quorum` over >= 3 independent
endpoints (`agents/docker-compose.yml`, verified accepted by
`agents-v2.3.0`; an unknown value is rejected at startup); relayer uses
`fallback` with `index.chunk=100` so public `eth_getLogs` caps are honoured
(verified: it indexed mainnet in 100-block chunks from keyless endpoints);
the keeper takes a comma-separated list, builds a viem `fallback` transport
(ordered, not latency-ranked), appends the public rotation behind any
configured URL unless the URL is a loopback fork, and scans gas-drop logs in
200-block chunks. Writes stay on Flashbots Protect. Public endpoints trade
latency for cost: throttled runs retry later, nothing is dropped.

## Not covered
* Hyperlane core contract internals (upstream audits apply).
* Real-mainnet MEV behaviour of the Etica swap (no private relay exists on
  Etica; mitigated by slippage/impact caps only).
* Validator key compromise beyond what the rate limit bounds.
* RPC/log provider truncation on mainnet (forks return complete logs); the
  keeper fails closed — a failed scan skips drops for that run — and scans
  in 200-block `eth_getLogs` chunks so public range caps error out loudly
  instead of silently truncating.
* RPC trust (F-18): reads fail over across several public endpoints. The
  keeper and relayer verify everything against on-chain state / the ISM, so
  an endpoint can only delay them. The validator cannot verify what it
  signs, so it runs its endpoints in `quorum` mode; with one endpoint (or
  `fallback`) a single malicious RPC could get it to sign a checkpoint for a
  fabricated lock. Quorum over keyless public nodes is a weaker guarantee
  than independent validators — still bounded by the 5k/day release cap.

## Mainnet blockers (in order)
1. OWNER = Safe; GUARDIAN, KEEPER, VALIDATOR distinct keys; validator key
   generated on its host.
2. Ethereum RPC list: >= 3 independent endpoints for the validator quorum
   (public rotation is the default; a paid URL may lead the list).
3. Fund KEEPER (>= 0.05 ETH for the deploy, 60 EGAZ) and VALIDATOR with dust ETH.
4. `deploy.sh all`, then confirm on-chain: `feeRecipient()` on both routers,
   `owner()` of both fee contracts == KEEPER, ISM module lists/thresholds
   (Ethereum 3-of-3 aggregation, Etica 2-of-2), rate-limit capacity, and
   that the agents run `agents-v2.3.0` or later (F-7).
5. Seed the USDC.e/ETX pool (10,000 ETX pair-creation fee) so the Etica
   top-up has liquidity.
6. Bridge-gas workflow dry run against mainnet, then live.
7. Publish "automated, single-validator at launch" wording on the bridge page.
8. Add validators and raise the threshold before TVL grows.
