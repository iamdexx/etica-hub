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
