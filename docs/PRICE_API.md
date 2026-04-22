# EticaHub Price API (v1)

Public, read-only JSON API exposing live prices and pair state for the
EticaSwap V2 deployment on Etica mainnet (chain id 61803). Served from
[eticahub.com/api/v1](https://eticahub.com/api/v1) with permissive CORS so
third-party dapps and aggregators can consume it directly from the browser.

## Design goals

- **Zero new infra.** Every endpoint reads directly from RPC at request time.
  No indexer, no database, no queue. Responses are cached for 30 seconds at
  the Next.js / CDN layer so a burst of polling doesn't hammer the chain.
- **CoinGecko-compatible where possible.** `/simple/price` mirrors the
  CoinGecko query + response shape so consumers can swap host names with
  minimal adapter code.
- **Current spot only, for now.** Prices are derived from pair reserves.
  Historical candles, 24h volume, and open-interest fields wait on the
  indexer (F.12.c) — the shapes will extend rather than break when they
  ship.
- **Relative quotes, no USD.** ETI / ETX / EGAZ don't have a protocol-owned
  USD oracle. Aggregators that list us supply their own USD reference rate
  and multiply. The API quotes every price in ETX (the hub token) plus a
  small pivot table to other Etica-native tokens.

## Endpoints

All responses are JSON, status 200 on success, error shape:

```json
{ "error": "human-readable message", "hint": "optional next-step text" }
```

### `GET /api/v1/tokens`

Static list of tokens the API currently reports on. Derived from the shared
`DEPLOYMENTS` + `EXTERNAL_ADDRESSES` registries — no RPC calls.

```json
{
  "chainId": 61803,
  "chain": "etica-mainnet",
  "count": 4,
  "tokens": [
    {
      "id": "egaz",
      "symbol": "EGAZ",
      "name": "Etica Gas",
      "decimals": 18,
      "address": null,
      "wrappedAddress": "0x232f…E11a",
      "isNative": true
    },
    ...
  ]
}
```

### `GET /api/v1/pairs`

Every registered EticaSwap V2 pair with live reserves. `price` is quoted
in ETX where the pair contains ETX; pairs that don't contain ETX return
`price: null` (route via `/api/v1/simple/price` instead).

### `GET /api/v1/pairs/[address]`

Detail view for a single pair address. Returns both price directions
(`token0InToken1` and `token1InToken0`).

### `GET /api/v1/simple/price?ids=eti,etx&vs_currencies=etx,egaz`

CoinGecko-compatible simple price lookup.

- `ids` — CSV of token ids (see `/api/v1/tokens` for the set).
- `vs_currencies` — CSV of quote currencies, same set.

Response mirrors CoinGecko:

```json
{
  "eti": { "etx": 0.12, "egaz": 3.4 },
  "etx": { "etx": 1, "egaz": 28.9 }
}
```

One-hop routing via ETX is used for pairs without a direct pool (e.g.
ETI → EGAZ is computed as `price(ETI → ETX) × price(ETX → EGAZ)`). A value
of `null` means no route could be found at current reserves.

### `GET /api/v1/stats`

Snapshot suitable for a status page: chain id, current block number, ETX
hub token address, pair count, and the list of tokens with at least one
live pair. 24h volume / TVL will appear here when the indexer ships.

## Caching

Every endpoint sets `Cache-Control: public, s-maxage=30,
stale-while-revalidate=60`. Polling faster than every 30s won't yield
fresher data — please self-throttle.

## Limitations + roadmap

- **Launchpad-minted tokens** created via the factory's `createPair` path
  are returned inside `/api/v1/pairs` with `null` symbols. F.12.b.2 will
  add an on-demand ERC-20 metadata resolver so those surface by symbol.
- **No historical data.** OHLCV + 24h volume wait on the indexer (F.12.c),
  which we'll ship once there's demand or aggregator pressure.
- **No testnet.** Helvetia (chain id 61888) doesn't have EticaSwap
  deployed yet. Requests to this API always return mainnet data.
