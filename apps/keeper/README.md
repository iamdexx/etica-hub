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

Keeps the Hyperlane USDC ⇄ USDC.e relayer fuelled from the fees users pay,
with no treasury involvement. Each warp router skims 10 bps (≤ 5 USDC) of
every transfer into a `LinearFee` contract owned by the relayer EOA; this job
sweeps that into the relayer wallet and, when its ETH / EGAZ is under the
minimum, swaps just enough stable for wrapped gas on the chain's V2 router
(Uniswap on Ethereum, EticaSwap `USDC.e → ETX → WEGAZ` on Etica) and unwraps
it. Legs whose fee contract / USDC.e address are unset are skipped.

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
| `BRIDGE_GAS_{ETHEREUM,ETICA}_MIN_NATIVE` | `0.05` ETH / `20` EGAZ | Top up below this… |
| `BRIDGE_GAS_{ETHEREUM,ETICA}_TARGET_NATIVE` | `0.15` ETH / `60` EGAZ | …to this. |
| `BRIDGE_GAS_MAX_SLIPPAGE_BPS` | `300` | Max price impact vs. the marginal price; blocks instead of swapping into a thin pool. |
| `BRIDGE_GAS_DRY_RUN` | `true` without a key | |

Runs hourly from `.github/workflows/bridge-gas.yml`; a blocked or failed leg
fails the job, which `ops-alerts` turns into a Telegram message.
