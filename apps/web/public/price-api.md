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

### `GET /api/v1/tokens/[id]`

Per-token live snapshot: supply stats (total / circulating / burned) plus
spot price denominated in every other tracked token. Supply figures come
from direct `ERC-20.totalSupply()` and `balanceOf()` reads; circulating is
`totalSupply − balanceOf(0x…dEaD)` (extensible via the route's excluded
holders list).

```json
{
  "chainId": 61803,
  "chain": "etica-mainnet",
  "token": { "id": "etx", "symbol": "ETX", "decimals": 18, "address": "0xa5A1…" },
  "supply": {
    "totalSupply": "100000000000000000000000000",
    "totalSupplyFormatted": "100000000",
    "circulatingSupply": "…",
    "circulatingSupplyFormatted": "…",
    "burned": "…",
    "burnedFormatted": "…",
    "excludedHolders": ["0x000000000000000000000000000000000000dEaD"]
  },
  "prices": { "eti": 0.12, "egaz": 8.4, "wegaz": 8.4, "stetx": 1 }
}
```

### `GET /api/v1/supply/{total|circulating|burned}?token=etx`

Plain-text single-number endpoints sized for aggregator "Supply API URL"
fields (CoinGecko / CoinMarketCap). Response body is one decimal number
with no JSON wrapping — e.g. `100000000` — so it pastes directly into
submission forms.

- `?token=etx` (default) — any token id exposed by `/api/v1/tokens`.
- Subpath `total` returns `ERC-20.totalSupply()` formatted with token decimals.
- Subpath `burned` returns `balanceOf(0x…dEaD)`.
- Subpath `circulating` returns `total − burned` (monotone as the
  `TreasuryHarvester` burns POL LP over time).

### `GET /api/v1/stats`

Snapshot suitable for a status page: chain id, current block number, ETX
hub token address, pair count, and the list of tokens with at least one
live pair. 24h volume / TVL will appear here when the indexer ships.

### `GET /api/v1/ohlcv/[pair]?interval=1h&limit=100&base=etx`

OHLC candles for a single EticaSwap V2 pair, derived on-the-fly from
`Sync(uint112, uint112)` event logs. Returns candles in ascending time
order; the newest candle is the currently-open bucket.

- `interval` — one of `5m | 15m | 1h | 4h | 1d`. Default `1h`.
- `limit` — 1 ≤ limit ≤ 500. Default 100.
- `base` — optional token id (see `/api/v1/tokens`) to price. Defaults to
  the non-ETX side of the pair, falling back to `token0` when both sides
  are unknown to the registry.

```json
{
  "pair": "0x…",
  "base": "eti", "quote": "etx",
  "interval": "1h", "intervalSeconds": 3600,
  "fromBlock": "…", "toBlock": "…",
  "candles": [
    { "t": 1713312000, "o": 0.12, "h": 0.13, "l": 0.115, "c": 0.128, "samples": 17 },
    ...
  ]
}
```

Shipped specifically so DEX Screener / GeckoTerminal have a stable URL to
pull short-range candle history from without us running an indexer. Empty
intermediate buckets inherit the previous close so the series renders as
a continuous line. Deeper history still waits on F.12.c.

### `GET /api/v1/pools`

Superset of `/pairs` laid out in a CoinGecko / GeckoTerminal-style pools
schema: every pool has `base` and `quote` token objects, a stable
`pool_id` (`etica-mainnet_{address}`), raw reserves, and both price
directions. Where `/pairs` normalizes everything to ETX, `/pools` keeps
the pair's native `token0`/`token1` orientation so consumers can overlay
their own quote logic.

### `GET /api/v1/health`

Cheap liveness check for aggregator bots and status pages. Returns `ok:
true` iff RPC is reachable, the factory pair count decodes, and the head
block is less than 120s old. Returns `503` with the same body shape when
any of those checks fail.

```json
{
  "ok": true,
  "chainId": 61803,
  "headBlockNumber": "…",
  "headAgeSeconds": 4,
  "stale": false,
  "pairCount": 3,
  "responseTimeMs": 87,
  "errors": []
}
```

## Caching

Every endpoint sets `Cache-Control: public, s-maxage=30,
stale-while-revalidate=60`. Polling faster than every 30s won't yield
fresher data — please self-throttle.

## Limitations + roadmap

- **Launchpad-minted tokens** created via the factory's `createPair` path
  are returned inside `/api/v1/pairs` with `null` symbols. F.12.b.2 will
  add an on-demand ERC-20 metadata resolver so those surface by symbol.
- **Short-range OHLCV only.** `/ohlcv` back-computes candles from the
  last `limit × intervalSeconds` of history at request time. For the `5m`
  and `15m` intervals this is ~hours; for `1d` it's ~1.5 years but quite
  slow on first request. True deep OHLCV + 24h volume wait on the indexer
  (F.12.c), which we'll ship once there's demand or aggregator pressure.
- **No testnet.** Helvetia (chain id 61888) doesn't have EticaSwap
  deployed yet. Requests to this API always return mainnet data.
