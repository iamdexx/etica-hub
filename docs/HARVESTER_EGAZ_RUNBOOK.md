# Harvester — EGAZ gas-funding runbook

This runbook covers operating the treasury harvester in **live mode** via
the on-chain `TreasuryHarvester` delegation contract. The treasury
multisig never signs live harvest txs; instead, a dedicated **hot keeper
EOA** calls `harvester.harvest(pools)` once per cadence. This document
explains how to fund, monitor, and rotate that keeper.

---

## Why a separate hot keeper

The harvester contract holds **approvals**, not balances. The treasury
pre-authorizes LP + ETX transfers, then a low-privilege EOA drives the
pipeline:

```
treasury (multisig)  ─approve(LP, harvester)────┐
                                                 ▼
                                      ┌─────────────────┐
hot keeper EOA  ─harvest(pools)─────► │ TreasuryHarvester│
                                      └─────────────────┘
                                                 │
                                                 ├─ burn LP → ETX + nonEtx
                                                 ├─ swap nonEtx → ETX
                                                 ├─ distribute to stETX / farms
                                                 ├─ buy nonEtx with POL slice
                                                 ├─ addLiquidity → 0xdead
                                                 └─ retain rest in treasury
```

Compromise of the hot keeper key cannot:
- drain the treasury,
- change the reward destinations (owner-only setters),
- change the split ratios,
- harvest more than `maxBurnBpsPerRun` (default 100 bps / 1%) of treasury
  LP per call.

It **can** force one harvest per block up to that cap. Minimum viable
blast radius.

---

## One-time setup

### 1. Deploy `TreasuryHarvester`

Already done via PR #86 — `packages/contracts/src/etx/TreasuryHarvester.sol`.
Record the deployed address in:

- `packages/shared/src/addresses.ts` → `DEPLOYMENTS[61803].treasuryHarvester`
- GitHub repository variable `HARVEST_HARVESTER_ADDRESS`

### 2. Configure slices on-chain

From the treasury multisig, call:

```solidity
harvester.setEtx(ETX);                  // canonical reward token
harvester.setStakedEtx(stETX_VAULT);    // optional; zero routes to treasury
harvester.setFarms(LP_FARMS);           // optional; zero routes to treasury
harvester.setSplit(1000, 1000, 4000, 4000); // stETX / farms / POL / treasury (bps, sums to 10000)
harvester.setMaxBurnBpsPerRun(100);     // 1% of treasury LP per run
```

These mirror the keeper-side env defaults.

### 3. Pre-approve allowances

From the treasury multisig, once per deployed pool + ETX:

```solidity
IERC20(ETI_ETX_PAIR).approve(harvester,   type(uint256).max);
IERC20(WEGAZ_ETX_PAIR).approve(harvester, type(uint256).max);
IERC20(ETX).approve(harvester,            type(uint256).max);
```

These approvals are how the treasury *delegates* the pipeline without
handing over its key. They can be revoked at any time to pause
harvesting.

### 4. Provision the hot keeper EOA

Generate a fresh EOA (any wallet, any machine you control — this key
does not need hardware custody). Record its address.

From the treasury multisig:

```solidity
harvester.setKeeper(HOT_KEEPER_ADDRESS);
```

In GitHub: set the `HARVEST_KEEPER_PRIVATE_KEY` **environment secret**
on the `harvest-live` environment (not a repo secret — environment
secrets can be gated with manual approval). Never commit the key to the
repo, never put it in repo-scoped env.

### 5. Fund the hot keeper with EGAZ

The keeper pays gas in **native EGAZ**. Each `harvest(pools)` call costs
roughly:

| Item                          | Gas (approx.) |
| ----------------------------- | ------------- |
| 2× `pair.transferFrom` burn   | ~200k         |
| 2× `pair.burn`                | ~180k         |
| 2× `router.swapExactTokensForTokens` | ~260k  |
| 2× POL `router.swap` + `router.addLiquidity` | ~420k |
| 2× distribute (stETX + farms) | ~120k         |
| treasury residual transfer    | ~30k          |
| **Total**                     | **~1.2 M gas** |

At a conservative 1 gwei gas price:
`1_200_000 × 1e-9 = 0.0012 EGAZ per run`.

Assuming daily cadence + headroom for retries + fee spikes, **fund the
keeper with ~100 EGAZ per quarter**. That's roughly 80,000× the steady
state — intentionally overprovisioned so a single gas spike doesn't
strand the keeper for a cycle.

Refill cadence:
- **Monitor**: `balanceOf(HOT_KEEPER_ADDRESS)` on the live RPC.
- **Warn** when balance drops below 50 EGAZ.
- **Refill** to 100 EGAZ at the start of each quarter, or earlier if
  balance crosses the warn threshold.

---

## Running a live harvest

### Manual dispatch

`.github/workflows/harvest-live.yml` is a `workflow_dispatch`-only job —
no cron. To trigger:

1. GitHub → Actions → **Harvest (live)** → **Run workflow**.
2. Type `HARVEST` into the confirmation input (guards against accidental
   clicks).
3. The job verifies:
   - `HARVEST_HARVESTER_ADDRESS` repo var is set,
   - `HARVEST_KEEPER_PRIVATE_KEY` environment secret is present,
   - `config.dryRun === false` (the runner's internal guard),
   - `harvester.keeper()` on-chain matches the signer derived from the
     keeper private key (prevents a stale key from burning gas on a tx
     the contract would revert),
4. Submits exactly one `harvester.harvest(pools)` tx and logs the hash.

### Scheduled dry-runs (always on)

`.github/workflows/harvest.yml` runs on cron, uses no private key, and
**always** executes with `HARVEST_DRY_RUN=true`. When
`HARVEST_HARVESTER_ADDRESS` is set, it additionally logs the delegation
calldata so operators can review the exact `PoolPlan[]` that would be
submitted live.

Policy: **only trigger a live run after the most recent dry-run is
healthy** — no errors in logs, plan sizes within expected bounds,
expected ETX harvest within an order of magnitude of the prior run.

### Inspecting a live run

`runHarvestLive` emits one of:

```
[harvest:live] delegation run complete — submitted=1 skipped=false
[harvest:live] delegation run complete — submitted=0 skipped=true   # no-op; no treasury LP
[harvest:live] error: ...                                            # revert, signer mismatch, etc.
```

If `submitted=0 skipped=false error=...`, the tx never left the worker —
check `harvester.keeper()` on-chain against the signer address.

If a tx reverts on-chain, pull the calldata from the workflow logs +
`cast` the failing call against the fork:

```
cast call --rpc-url $HARVEST_RPC_URL \
  $HARVEST_HARVESTER_ADDRESS \
  "harvest((address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256)[])" \
  '[(0x...,0x...,...,...,...,...,...,...,...)]' \
  --from $HARVEST_KEEPER_ADDRESS
```

Most common revert causes:
- `MaxBurnExceeded` — `maxBurnBpsPerRun` was lowered between runs;
  reduce `HARVEST_BURN_BPS_PER_RUN` to match.
- `SlippageExceeded` — volatile market; lower `HARVEST_BURN_BPS_PER_RUN`
  or raise `HARVEST_MAX_SLIPPAGE_BPS` temporarily.
- `PolAllocationInvalid` — planner + contract disagree on POL slice;
  re-run dry-run to check, file issue if the assertion trips twice.

---

## Key rotation

### Routine rotation (quarterly, recommended)

1. Generate a new hot keeper EOA.
2. Treasury multisig: `harvester.setKeeper(NEW_KEEPER_ADDRESS)`.
3. Fund the new EOA with ~100 EGAZ.
4. Update `HARVEST_KEEPER_PRIVATE_KEY` environment secret on the
   `harvest-live` environment.
5. Trigger a live run; verify the submitted tx originated from the new
   address.
6. Sweep residual EGAZ from the old keeper back to treasury:
   `cast send --private-key $OLD_KEEPER_KEY --value $BALANCE $TREASURY`.

The old key's on-chain authority is revoked the moment step 2 lands —
step 6 is just housekeeping.

### Emergency rotation (suspected key compromise)

1. Treasury multisig **immediately** calls either:
   - `harvester.setKeeper(0x0)` — disables harvesting entirely, or
   - `harvester.setKeeper(NEW_KEY)` — switches to a freshly generated
     EOA.
2. Optionally revoke approvals if the harvester contract itself is
   suspect: `IERC20(pair).approve(harvester, 0)`.
3. Rotate the GitHub secret.
4. Sweep residual EGAZ from the compromised key.

The compromise radius is bounded by `maxBurnBpsPerRun` + the attacker's
willingness to burn keeper gas calling `harvest()` with adversarial
slippage. Losses are capped at that fraction × treasury LP × realized
slippage, which in practice is minutes-scale of LP fee capture, not
principal.

---

## Sanity checklist before each live dispatch

- [ ] Most recent dry-run workflow succeeded (green check, no errors in logs).
- [ ] Dry-run log shows `delegation:` section with sane `totalPolAssigned`.
- [ ] Keeper EOA balance ≥ 1 EGAZ (>> enough for one tx).
- [ ] `harvester.keeper()` on-chain matches the signer derived from the
      secret (the runner asserts this, but verify once after rotations).
- [ ] No open governance proposal changes treasury, slices, or pools.

---

## References

- Contract source: `packages/contracts/src/etx/TreasuryHarvester.sol`
- Runner source: `apps/keeper/src/harvest/run.ts`
- Delegation builder: `apps/keeper/src/harvest/delegation.ts`
- Live entry point: `apps/keeper/src/harvest/run-live.ts`
- Workflows: `.github/workflows/harvest.yml` (dry-run cron),
  `.github/workflows/harvest-live.yml` (manual dispatch)
