# GeckoTerminal — Submission Brief

## Status

**Etica Mainnet is NOT indexed by GeckoTerminal.** GeckoTerminal supports
~267 chains and pulls its chain list + DEX indexers from CoinGecko's backend.
Etica has two CoinGecko-listed assets (ETI, EGAZ) as plain tokens, but
neither the chain's DEXes nor EticaSwap's pools are indexed.

## Form

GeckoTerminal uses the same submission flow as CoinGecko. You'll either:
1. Submit the EticaSwap DEX via the **CoinGecko DEX form**
   (https://www.coingecko.com/en/dexes/new) — see
   [`COINGECKO.md`](./COINGECKO.md) "Submission 2". Once that DEX is
   accepted, GeckoTerminal picks up its pools automatically.
2. Or request chain-level integration via the CoinGecko support form
   (https://support.coingecko.com/hc/en-us/requests/new), choosing
   **GeckoTerminal → Add a network** as the topic.

**Do #1 first** — it's the path of least resistance and resolves the
GeckoTerminal listing as a side-effect.

## Why a separate brief

The CoinGecko DEX form asks a subset of questions; GeckoTerminal cares about
a few extra fields (trade-level event signatures, OHLCV availability, RPC
reliability) that you'll need if you end up on path #2. This doc collects
both.

## Chain integration request — copy/paste

Use this if the CoinGecko DEX submission doesn't propagate to
GeckoTerminal within 2–3 weeks. File it through CoinGecko support,
**GeckoTerminal → Add a network**:

> **Subject:** Add network — Etica Mainnet (EVM, chain id 61803)
>
> Hi GeckoTerminal team,
>
> Requesting addition of **Etica Mainnet** to GeckoTerminal. CoinGecko
> already tracks the chain's native coin EGAZ
> (https://www.coingecko.com/en/coins/egaz) and protocol token ETI
> (https://www.coingecko.com/en/coins/etica) as plain tokens, so the chain is
> already recognized on CoinGecko's side. This request is to extend that
> coverage to on-chain pool data via GeckoTerminal.
>
> ### Chain
>
> | | |
> |---|---|
> | Chain name | Etica Mainnet |
> | EVM chain id | 61803 (`0xf16b`) |
> | Native coin | EGAZ (18 decimals) |
> | Genesis | 2021-10-16 (Ethash PoW) |
> | Chainlist.org | https://chainlist.org/chain/61803 |
>
> ### RPC endpoints (public, no key, CORS-enabled)
>
> - `https://eticamainnet.eticascan.org`
> - `https://eticamainnet.eticaprotocol.org`
> - `https://61803.rpc.thirdweb.com`
>
> ### DEX to index: EticaSwap V2 (Uniswap V2 fork)
>
> | | |
> |---|---|
> | Factory | `0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3` |
> | Router | `0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723` |
> | Factory event | `PairCreated(address indexed token0, address indexed token1, address pair, uint256)` |
> | Pair reserves event | `Sync(uint112 reserve0, uint112 reserve1)` |
> | Pair swap event | `Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)` |
> | Pair ABI | Standard Uniswap V2 Pair |
> | Hub token (ETX) | `0xa5A1Bc6307b0b87989B8456D4b35F88a68650044` |
> | Wrapped native (WEGAZ) | `0x232fb2B87CAce92B2438054A7eB79B4081E3E11a` |
>
> ### Public price/market API we already ship
>
> CoinGecko-compatible endpoints at https://eticahub.com/api/v1:
> - `/tokens` — tokens with decimals + addresses
> - `/pairs` — every factory pair + live reserves + ETX-denominated spot price
> - `/pairs/{pairAddress}` — single pair detail
> - `/simple/price?ids={coinIds}&vs_currencies={vs}` — CoinGecko-shaped price quote, one-hop through ETX
> - `/stats` — chain head block + pair count
>
> Schema and examples: https://github.com/iamdexx/etica-hub/blob/main/docs/PRICE_API.md
>
> If GeckoTerminal prefers to poll our API rather than directly indexing
> RPC/logs, that endpoint is stable, CORS-enabled, rate-limited at the CDN
> layer (Vercel defaults), and served with `Cache-Control: public, s-maxage=30,
> stale-while-revalidate=60`.
>
> ### OHLCV availability
>
> Not shipped yet — happy to ship a `/api/v1/ohlcv/{pair}` endpoint
> (15m/1h/4h/1d candles derived from `Sync` events) on your request before
> integration starts. Let me know the preferred schema.
>
> ### Contact
>
> - GitHub: https://github.com/iamdexx/etica-hub
> - Email: (on `eticahub.com` domain)
>
> Thanks,
>
> — (your name)
> EticaHub maintainer

## If they ask for OHLCV before listing

GeckoTerminal's pool page shows candlestick charts; they derive OHLCV from
raw swap events in most integrations, but sometimes ask the project to pre-
compute and expose candles to skip the indexer cost. If that comes up,
ping me — shipping `/api/v1/ohlcv/{pair}` is ~half a day of work (back-
derive from `Sync` events over the last N blocks, cache at the CDN).

## Pitfall to avoid

Don't submit the chain integration AND the DEX submission on CoinGecko in
parallel at the same email — do the DEX submission first, wait 2–3 weeks,
THEN escalate to GeckoTerminal if the auto-propagation didn't happen. Double-
filing risks both tickets getting merged or rejected as duplicates.
