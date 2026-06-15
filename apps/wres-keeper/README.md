# @etica-hub/wres-keeper

Off-chain keeper for the **wRES** cross-chain product: lock a RES NFT on Etica →
mine with frozen TRX on TRON → get paid in ETX on Etica.

The keeper is the **only** cross-chain actor. It custodies no user principal —
every contract it talks to is drain-proof regardless of keeper honesty (a
compromised keeper can, at worst, fail to act). It just observes both chains and
executes the steps the contracts already permit.

## The loop

Each tick (default 60s) the keeper observes both chains, builds a plan, then
executes three independent legs. Any single failure is isolated and never aborts
the rest of the tick.

| Leg | Trigger | Actions |
|---|---|---|
| **Entry** | new `Locked` on Etica with no TRON twin yet | `mintTwin` (TRON) → optional `frontUpgrade` from the reserve (bounded by `frontableNow` this epoch) |
| **Payout** | a twin's settled reward ≥ `WRES_MIN_PAYOUT_TRX` | `claimForPayout` (TRON) → **1%** `topUp` to the reserve → mint eTRX 1:1 → approve → quote → swap eTRX→ETX to the holder's 0x wallet (Etica) |
| **Exit** | a matured, un-vetoed `requestUnlock` on the vault | permissionless `executeUnlock` (Etica) returns the RES to its locker |

`frontableNow` is read once per tick and debited locally, so multiple entries in
one tick can never over-front the reserve. The payout split is **re-derived from
the actually-claimed amount** (not the planned snapshot) so mid-tick accrual
can't desync the 1% / 99% math.

## Architecture

```
src/
  config.ts        env -> typed config (TRX policy parsed to SUN bigint)
  types.ts         domain types + SUN_PER_TRX / BPS_DENOMINATOR constants
  abi.ts           minimal ABIs (RESLockVault, ETRX on Etica; Miner, Reserve on TRON)
  utils.ts         SUN<->eTRX-wei conversion, TRX formatting, withRetry backoff
  telegram.ts      optional failure alerts
  planner.ts       PURE: Observation -> KeeperPlan (entries/payouts/exits)
  monitor.ts       observe(): parallel cross-chain reads with retry
  executor.ts      executePlan(): ordered on-chain calls; dry-run safe
  keeper.ts        createKeeper() + runTick() (observe -> plan -> execute)
  index.ts         long-running loop, SIGINT/SIGTERM, Telegram alerts
  dry-run.ts       one-shot: forces dry-run, runs one tick, exits
  chains/
    types.ts       EticaClient / TronClient interfaces (the only chain seam)
    etica.ts       viem adapter
    tron.ts        tronweb adapter
```

The orchestration (`planner`/`monitor`/`executor`/`keeper`) depends only on the
`EticaClient` / `TronClient` interfaces — never on viem or tronweb directly —
which is what makes the whole decision path unit-testable with in-memory fakes.

## Scripts

```bash
pnpm dry-run       # one-shot: read both chains, log what it WOULD do, exit
pnpm keeper:once   # alias of dry-run (single validation pass)
pnpm keeper        # long-running loop (tsx)
pnpm build         # tsc -> dist/
pnpm start         # node dist/index.js (after build)
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run
```

## Dry-run mode (validate before mainnet)

Dry-run is the default safety posture: **if neither private key is set, the
keeper forces dry-run** and never broadcasts. You can also force it explicitly
with `WRES_DRY_RUN=true` even when keys are present.

In dry-run the keeper still does all the **reads** (so you see the real plan
against live state) but every **write** is replaced by a log line. Recommended
pre-mainnet flow:

1. `cp .env.example .env`
2. Fill in RPC endpoints + the four contract addresses. **Leave the two
   `*_PRIVATE_KEY` fields blank.**
3. `pnpm dry-run`
4. Inspect the log: it prints each `mintTwin` / `frontUpgrade` / `claimForPayout`
   / `topUp` / swap / `executeUnlock` it *would* send, with amounts. No funds
   move.

Point step 2 at testnet first (TRON Nile + an Etica testnet RPC) for an
end-to-end rehearsal before any mainnet keys are introduced.

## Configuration

Every variable is documented in [`.env.example`](./.env.example). Summary:

- **Etica:** `WRES_ETICA_RPC_URL`, `WRES_ETICA_CHAIN_ID`,
  `WRES_RES_LOCK_VAULT_ADDRESS`, `WRES_ETRX_ADDRESS`, `WRES_ETX_ADDRESS`,
  `WRES_DEX_ROUTER_ADDRESS`
- **TRON:** `WRES_TRON_RPC_URL`, `WRES_WRAPPED_RES_MINER_ADDRESS`,
  `WRES_TRX_RESERVE_ADDRESS`, `WRES_TRON_FEE_LIMIT_SUN`
- **Signers:** `WRES_KEEPER_TRON_PRIVATE_KEY`, `WRES_KEEPER_ETICA_PRIVATE_KEY`
  (blank ⇒ dry-run)
- **Policy:** `WRES_INITIAL_FRONT_TRX`, `WRES_MIN_PAYOUT_TRX`,
  `WRES_RESERVE_TOPUP_BPS` (default `100` = 1%), `WRES_MAX_SLIPPAGE_BPS`
  (default `100` = 1%)
- **Loop:** `WRES_SCAN_LOOKBACK_BLOCKS`, `WRES_POLL_INTERVAL_MS`, `WRES_DRY_RUN`
- **Alerts:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional)

TRX policy fields are entered as **decimal TRX** and stored internally as **SUN**
(`bigint`, 1 TRX = 1e6 SUN), so the loop never juggles units.

## Deployment (droplet)

The keeper is a plain long-running Node process. On the droplet:

```bash
git clone https://github.com/iamdexx/etica-hub.git
cd etica-hub && pnpm install
cd apps/wres-keeper
cp .env.example .env   # fill in RPCs, contract addresses, and the two keys
pnpm build
pnpm start             # or: pnpm keeper (tsx, no build step)
```

Run a dry-run on the droplet first (`pnpm dry-run` with the keys blank) to
confirm it reaches both chains and reads sane state, then add the keys and
start. As a systemd unit:

```ini
# /etc/systemd/system/wres-keeper.service
[Unit]
Description=wRES keeper
After=network-online.target

[Service]
WorkingDirectory=/root/etica-hub/apps/wres-keeper
EnvironmentFile=/root/etica-hub/apps/wres-keeper/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now wres-keeper
journalctl -u wres-keeper -f
```

The keeper handles `SIGINT`/`SIGTERM` gracefully: it finishes the current tick,
then exits — so `systemctl restart` never interrupts a mid-flight broadcast.

## Safety properties

- **No principal custody.** The keeper holds no locked RES and no frozen TRX; it
  can't release either. Contracts enforce this on-chain.
- **Reserve can't run dry.** `frontUpgrade ≤ frontableNow` (min of balance and
  the per-epoch drip cap), enforced by `TrxReserve` and respected by the
  executor's local budget debit.
- **Permissionless exits.** `executeUnlock` is callable by anyone; the keeper
  runs it only as a liveness convenience and can never gate or seize a user's
  RES.
- **Dry-run by default** whenever keys are absent — a misconfigured deploy reads
  and logs but cannot move funds.
```
