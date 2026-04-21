# @etica-hub/orderbook

Off-chain order book for EticaHub's non-custodial trading. Stores signed
UniswapX `DutchOrder` blobs + signatures; serves them to keepers; records
on-chain fill/cancel tx hashes. **Never holds funds or keys.**

## API

| Method | Path                         | Purpose                                          |
|--------|------------------------------|--------------------------------------------------|
| GET    | `/health`                    | Liveness check                                   |
| POST   | `/orders`                    | Submit a signed order                            |
| GET    | `/orders`                    | List orders (filter by status/swapper/tokens)    |
| GET    | `/orders/:hash`              | Fetch a single order                             |
| POST   | `/orders/:hash/cancel`       | Record a user-initiated cancel tx                |
| POST   | `/orders/:hash/mark-filled`  | Keeper reports a landed fill tx (auth required)  |

`:hash` is `keccak256(encodedOrder)` — returned in the 201 response from
`POST /orders`. This is a stable storage key but **not** identical to
UniswapX's on-chain EIP-712 order hash; the two can be added side-by-side
later without breaking clients.

## Run locally

```bash
pnpm --filter @etica-hub/orderbook install
pnpm --filter @etica-hub/orderbook dev
```

Env vars (all optional in dev):

| Variable              | Default              | Purpose                                          |
|-----------------------|----------------------|--------------------------------------------------|
| `ORDERBOOK_HOST`      | `0.0.0.0`            | Bind host                                        |
| `ORDERBOOK_PORT`      | `3100`               | Bind port                                        |
| `ORDERBOOK_DB_PATH`   | `./orderbook.db`     | SQLite file                                      |
| `KEEPER_AUTH_TOKEN`   | _(unset)_            | If set, required on `POST /orders/:hash/mark-filled` via `X-Keeper-Auth` header |
| `CORS_ORIGIN`         | `*`                  | Comma-separated CORS allow-list                  |

## Why SQLite (for now)

Dev + small-scale prod is fine on SQLite with WAL mode; Postgres support
lands in a follow-up once the keeper network has enough active orders to
make concurrent writes meaningful. The `OrderRepository` interface is the
only place the driver leaks through — swapping in `pg` is ~100 LoC.

## What the orderbook does NOT do

- It does **not** re-verify EIP-712 signatures. UniswapX signatures are
  actually Permit2 witness signatures, which are non-trivial to recover
  off-chain. The reactor verifies on-chain during `execute`, which is the
  authoritative check.
- It does **not** hold funds, keys, or simulate swaps. The keeper is
  responsible for simulating and submitting fills; see `apps/keeper`.
- It does **not** watch the chain for `Fill` events. Keepers call
  `POST /orders/:hash/mark-filled` after landing their tx, and users can
  call `POST /orders/:hash/cancel` after broadcasting a Permit2 nonce
  invalidation. A future indexer extension can close the loop so lost
  keeper reports don't leave stale `open` rows.
