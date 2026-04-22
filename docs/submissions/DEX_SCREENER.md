# DEX Screener — Submission Brief

## Status

**Etica Mainnet is NOT supported.** DEX Screener currently indexes ~20
chains (Ethereum, Solana, BNB, Base, Arbitrum, Polygon, Optimism, Fantom,
Avalanche, Blast, Gnosis, Harmony, KCC, Cronos, Oasis, Tron, Pulse, etc.).
Listing Etica requires them to add the chain itself — a larger scope than a
single-token listing.

## Form

DEX Screener doesn't publish an open chain-integration form. The documented
path is:
1. Join their Discord: https://discord.gg/dexscreener
2. Open a ticket in `#new-chain-requests` or DM their listings account, OR
3. Email `contact@dexscreener.com` with subject `New chain integration
   request: Etica Mainnet (61803)`.

Realistic turnaround: weeks to months. They prioritize chains with
demonstrated trading volume; low-volume chains get deferred indefinitely.

## Email / Discord message template — copy/paste

> **Subject:** New chain integration request — Etica Mainnet (EVM, chain id 61803)
>
> Hi DEX Screener team,
>
> I'd like to request integration of **Etica Mainnet** on DEX Screener.
>
> ### Chain
>
> | | |
> |---|---|
> | Chain name | Etica Mainnet |
> | EVM chain id | 61803 (`0xf16b`) |
> | Native coin | EGAZ (18 decimals) |
> | Consensus | Ethash PoW |
> | Genesis | 2021-10-16 |
> | Chainlist.org | https://chainlist.org/chain/61803 |
> | Primary explorer | https://eticascan.org |
> | Our explorer | https://eticahub.com/explorer |
>
> ### RPC endpoints (public, no API key)
>
> - `https://eticamainnet.eticascan.org`
> - `https://eticamainnet.eticaprotocol.org`
> - `https://61803.rpc.thirdweb.com`
>
> All three support standard JSON-RPC methods including `eth_getLogs`,
> `eth_getBlockByNumber`, `eth_call`, and WebSocket subscriptions on the
> `/ws` path.
>
> ### DEX to index: EticaSwap V2
>
> Uniswap V2 fork with an ETX hub-and-spoke constraint enforced at the
> factory (every pair must include ETX — the governance token).
>
> | | |
> |---|---|
> | Factory | `0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3` |
> | Router | `0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723` |
> | Pair ABI | Standard Uniswap V2 Pair |
> | Hub token (ETX) | `0xa5A1Bc6307b0b87989B8456D4b35F88a68650044` |
> | WETH analog (WEGAZ) | `0x232fb2B87CAce92B2438054A7eB79B4081E3E11a` |
>
> Events emitted (identical to Uniswap V2):
> - Factory: `PairCreated(address indexed token0, address indexed token1, address pair, uint256)`
> - Pair: `Sync(uint112 reserve0, uint112 reserve1)` — fires on every trade, supply our price signal
> - Pair: `Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)`
> - Pair: `Mint(address indexed sender, uint256 amount0, uint256 amount1)` and `Burn(...)` for LP events
>
> ### Existing price/market-data API (optional shortcut)
>
> We expose a CoinGecko-compatible public API you can consume instead of
> polling RPC yourself:
>
> - `https://eticahub.com/api/v1/pairs` — every factory pair + live reserves + ETX-denominated spot
> - `https://eticahub.com/api/v1/pairs/{pairAddress}` — single pair detail
> - `https://eticahub.com/api/v1/simple/price?ids=eti,etx&vs_currencies=etx,egaz` — CoinGecko-shaped price
> - `https://eticahub.com/api/v1/stats` — chain head block + factory pair count
>
> Full schema: https://github.com/iamdexx/etica-hub/blob/main/docs/PRICE_API.md
>
> ### Sample pairs with active volume
>
> (Attach a CSV snapshot the day of submission from
> `https://eticahub.com/api/v1/pairs` — DEX Screener's triage looks for
> non-zero 24h volume before scheduling integration work.)
>
> ### What we can provide to speed up integration
>
> - Dedicated indexer RPC if needed (we run our own fallback RPC already).
> - Cooperation with whichever of your engineers works on Etica — we're
>   responsive on Discord (`https://discord.com/invite/5QyKhENXgb`) and
>   GitHub (`https://github.com/iamdexx/etica-hub`).
> - Historical OHLCV backfill from `Sync` events on request.
>
> Happy to jump on a call if helpful.
>
> Thanks,
>
> — (your name)
> EticaHub maintainer, https://eticahub.com
> (email on eticahub.com domain)

## Follow-up

After sending, log the Discord ticket ID / email thread in a project
tracker. DEX Screener rarely responds the first time; a polite follow-up
every 3–4 weeks is reasonable. Increase priority if/when EticaSwap 24h
volume crosses ~$10k — they're volume-driven.

## Pitfall to avoid

Do **not** spam `#new-chain-requests` with multiple messages. One ticket, one
email, one follow-up cadence. DEX Screener mods have been known to
deprioritize noisy requesters.
