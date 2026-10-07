# @etica-hub/keeper

Reference keeper for the EticaHub non-custodial trading stack.

A keeper polls the [order-book API](../orderbook/README.md) for open signed
orders and (in a future revision) submits matching `execute(...)` fill
transactions to the UniswapX `DutchOrderReactor`. In exchange, keepers collect
the Dutch-decay spread as their fee.

**Keepers are not privileged.** Anyone can run one. This implementation is
published as a reference; production operators are expected to fork it and
tune their own strategy (gas price, profitability threshold, private mempool,
etc.).

## What this v1 does

- Polls `GET /orders?status=open` every `KEEPER_POLL_INTERVAL_MS` ms.
- Filters to orders that are for our reactor, haven't expired, and whose
  Dutch-decay window has started.
- Logs a structured line per fillable order.
- Handles `SIGINT` / `SIGTERM` for clean shutdown.

## What this v1 does **not** do yet

- Simulate fills on-chain to gauge profitability.
- Submit `reactor.execute(...)` transactions.
- Report landed fills via `POST /orders/:hash/mark-filled`.
- Hold user keys or funds — and it **never will**. Keepers touch their own
  signer key for gas; they never see the swapper's private key. The reactor
  pulls user tokens via Permit2 atomically inside the fill tx.

## Environment

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `ORDERBOOK_URL` | yes | — | Base URL of the order-book API, e.g. `http://localhost:3100`. |
| `KEEPER_RPC_URL` | yes | — | Etica RPC endpoint for reads. |
| `KEEPER_REACTOR_ADDRESS` | yes | — | Deployed `DutchOrderReactor` address. |
| `KEEPER_CHAIN_ID` | no | `61803` | Etica mainnet. |
| `KEEPER_PRIVATE_KEY` | no | — | Signer key for fill txs (v2+). Never share. |
| `KEEPER_AUTH_TOKEN` | no | — | If the orderbook is run with `KEEPER_AUTH_TOKEN` set, match it here so `mark-filled` calls succeed. |
| `KEEPER_POLL_INTERVAL_MS` | no | `5000` | |
| `KEEPER_POLL_BATCH_SIZE` | no | `50` | Orders per poll. |
| `KEEPER_DEADLINE_GRACE_SECONDS` | no | `30` | Skip orders whose deadline is within this window. |

## Run locally

```bash
pnpm install
pnpm --filter @etica-hub/keeper dev
```

## Run tests

```bash
pnpm --filter @etica-hub/keeper test
```

## Bridge gas (`bridge-gas:*`)

Keeps the Hyperlane USDC ⇄ USDC.e relayer fuelled from the fees users pay and
forwards the surplus to the treasury, with no treasury key involved. Each warp
router skims 50 bps (≤ 50 USDC; Etica redemptions add a flat 2 USDC.e) of
every transfer into a fee contract owned by the relayer EOA. Each run, per leg:

1. `claim()` accrued fees into the relayer wallet;
2. if ETH / EGAZ is under the minimum, swap just enough stable for wrapped gas
   on the pinned V2 router (Uniswap on Ethereum, EticaSwap
   `USDC.e → ETX → WEGAZ` on Etica) and unwrap. Exact-amount approvals, fresh
   deadline, `amountOutMin` from a marginal-price probe, slippage ceiling 5 %;
   Ethereum sends go through Flashbots Protect so the swap never sits in the
   public mempool;
3. transfer everything above `RESERVE_STABLE` to the treasury
   (`TREASURY_ADDRESS` from `@etica-hub/shared` — not an env var, so a leaked
   workflow variable cannot redirect it);
4. Etica only: send `BRIDGE_GAS_DROP_AMOUNT` EGAZ to each wallet that received
   ≥ 20 USDC.e in the last 600 blocks and still holds < 0.5 EGAZ. Recipients
   come from the router's own `ReceivedTransferRemote` events (i.e. messages
   the ISM accepted), 3 blocks behind head; a funded wallet is above the
   threshold so re-scans never pay twice; capped per run and by the keeper's
   own gas floor.

Legs whose fee contract / USDC.e address are unset are skipped; a blocked
swap (thin pool, no quote) holds the stable instead of sweeping it.

```bash
pnpm --filter @etica-hub/keeper bridge-gas:dry-run   # snapshot + plan, no txs
pnpm --filter @etica-hub/keeper bridge-gas:live      # needs HARVEST_PRIVATE_KEY
```

| Var | Default | Notes |
| --- | --- | --- |
| `HARVEST_PRIVATE_KEY` / `BRIDGE_GAS_PRIVATE_KEY` | — | The relayer EOA. Must be the fee contracts' owner. |
| `BRIDGE_GAS_ETHEREUM_RPC_URL` | — (required) | Provider URL. |
| `BRIDGE_GAS_ETICA_RPC_URL` | `HARVEST_RPC_URL` or rpc2.etica-stats.org | |
| `BRIDGE_GAS_{ETHEREUM,ETICA}_FEE_CONTRACT` | — | From the warp deploy output; blank = leg skipped. |
| `BRIDGE_GAS_ETICA_STABLE` | — | USDC.e router address; blank = leg skipped. |
| `BRIDGE_GAS_ETHEREUM_WRITE_RPC_URL` | `https://rpc.flashbots.net/fast` | Where Ethereum transactions are *sent* (reads use the RPC above). Point at the fork when testing. |
| `BRIDGE_GAS_{ETHEREUM,ETICA}_RESERVE_STABLE` | `500` / `25` | Stable kept as a gas reserve; the excess is swept to the treasury. |
| `BRIDGE_GAS_{ETHEREUM,ETICA}_MIN_SWEEP` | `200` / `5` | Smallest sweep worth a transaction. |
| `BRIDGE_GAS_MAX_SLIPPAGE_BPS` | `150` (max 500) | `amountOutMin` and price-impact ceiling for swaps. |
| `BRIDGE_GAS_DROP_ENABLED` / `_AMOUNT` / `_THRESHOLD` / `_MIN_TRANSFER` / `_MAX_PER_RUN` / `_LOOKBACK_BLOCKS` | `true` / `2` / `0.5` / `20` / `25` / `600` | Recipient gas drop on Etica. |
| `BRIDGE_GAS_{ETHEREUM,ETICA}_MIN_NATIVE` | `0.05` ETH / `20` EGAZ | Top up below this… |
| `BRIDGE_GAS_{ETHEREUM,ETICA}_TARGET_NATIVE` | `0.15` ETH / `60` EGAZ | …to this. |
| `BRIDGE_GAS_MAX_SLIPPAGE_BPS` | `300` | Max price impact vs. the marginal price; blocks instead of swapping into a thin pool. |
| `BRIDGE_GAS_DRY_RUN` | `true` without a key | |

Runs hourly from `.github/workflows/bridge-gas.yml`; a blocked or failed leg
fails the job, which `ops-alerts` turns into a Telegram message.
