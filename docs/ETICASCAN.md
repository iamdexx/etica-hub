# EticaScan (F.12) — scope & phased plan

> Status: **scope doc, pre-implementation.** No code in this PR other than
> this file. We agree on depth before I start building.

## Goal

Two pieces, usually conflated but separable:

1. **Block explorer** — a better, first-party UI for looking at Etica-mainnet
   blocks, transactions, addresses, tokens. Replaces the user-reported "not
   great" experience on the existing third-party `eticascan.org`.
2. **Price-data reporting** — push ETI, EGAZ, and ETX price + liquidity info
   into the public web3 price layer (CoinGecko, CoinMarketCap, GeckoTerminal,
   DEX Screener). Requires a stable, well-documented public price API on our
   side, then the listing workflow for each aggregator.

These ship in different PRs. The block explorer is visible to users; the
price API is mostly machine-to-machine and drives listings.

## Non-goals (explicitly out of scope for v1)

- **Full Etherscan parity.** We are not shipping verified-contract diffs,
  gas tracker, charts-everywhere, sourcify integration, or a read/write UI
  for arbitrary contracts in v1. These are all followups if users ask.
- **Public, keyed API tier.** No API keys, rate limiting, or billing in v1.
  Unauthenticated GETs only, with reasonable caching. We add keys when
  someone actually tries to scrape us.
- **Historical reorg analysis.** v1 trusts the RPC's head; if a reorg
  happens the explorer's cached pages will update on the next RPC read.
- **Non-EVM chains.** Etica mainnet (61803) only. No multichain UI.

## Constraints & priors

- No new paid infra. Both pieces must run on Vercel + RPC, same posture as
  the rest of the dapp. No Postgres, no Redis, no Fly.io, no indexer
  service *unless we decide to turn on the existing `apps/indexer`*.
- Mobile-first, same visual language as the rest of `eticahub.com`.
- Read-only on day one. No wallet required to use the explorer.
- Respects the RPC fallback pattern already in `apps/web/src/lib/rpc.ts` —
  reads try eticascan → eticaprotocol.org → thirdweb so a single RPC being
  flaky doesn't break the page.

## Phased plan

### Phase 1 — Skinny explorer (RPC-only, no index) — **~1 PR, ~1 day**

Adds `/explorer/*` routes to `apps/web`. Every page is a client-side viem
read against the configured RPC. No database, no indexer.

Routes:

- `/explorer` — landing. Shows last ~20 blocks, last ~20 txs, chain stats
  (block height, gas used %, EGAZ price, ETI/ETX TVL). Auto-refresh every
  block (`useBlockNumber({ watch: true })`).
- `/explorer/block/[n_or_hash]` — block header, miner, txs list.
- `/explorer/tx/[hash]` — tx header, from/to, value, gas, logs (raw +
  decoded against known ABIs: router, factory, pair, reactor, registry,
  ETX, EticaCore).
- `/explorer/address/[addr]` — balance (EGAZ), known labels (treasury,
  reactor, factory, …), last ~50 outgoing + incoming txs (pulled via
  `getLogs` on ERC-20 Transfer for any known token + native via block
  scan for recent tip). Warn that full history needs the Phase 2 indexer.
- `/explorer/token/[addr]` — totalSupply, decimals, name, symbol, last
  ~50 Transfer events, and for ETX/ETI/EGAZ: current spot price from the
  existing pair contracts + 24h volume (last-1k-blocks heuristic).

Search bar on the top nav: detects input shape (`0x[64]` → tx,
`0x[40]` → address/contract, pure int → block height, known symbols →
token redirect).

### Phase 2 — Indexer-backed depth — **~1-2 PRs, ~2-3 days, optional**

Turn on `apps/indexer` (already partially written in the repo). Index to
Neon/Supabase free tier. Unlocks:

- Full address history (not just last 50).
- Accurate token holder count + top holders.
- Gas-usage leaderboard.
- Confirmed historical OHLCV for `/trade/[token]` charts (retires the
  client-side fallback shipped in #43).

**Only do this phase if Phase 1 has visible traction / user complaints
about the skinny version.** Phase 1 is legitimately useful on its own.

### Phase 3 — Contract verification — **~1 PR, ~1 day, optional**

Upload + compile a Solidity source against an on-chain bytecode hash.
Reuses Foundry's `forge inspect` output. Verified contracts get pretty
decoded views on the tx and contract pages.

Low priority. Nice-to-have, not urgent.

## Price-data reporting

This is the "report to the greater web3" piece and is orthogonal to the
explorer UI. Delivered as its own PR.

### Deliverable

A stable, documented, CoinGecko-compatible public API under
`/api/v1/prices/*`, served by `apps/web` (Vercel serverless):

- `GET /api/v1/prices/tokens` — list of tracked tokens (ETI, EGAZ, ETX
  + any whitelisted pair token), with contract address, symbol,
  decimals, logo URL.
- `GET /api/v1/prices/simple` — CoinGecko-shaped:
  `{ [token_symbol]: { usd: <num>, usd_24h_vol: <num>, usd_24h_change: <num> } }`
- `GET /api/v1/prices/historical/[symbol]?from=&to=&resolution=1h` —
  OHLCV candles. Data source depends on phase (see below).
- `GET /api/v1/prices/pairs` — DEX Screener-compatible pair schema for
  each ETX-hub pair: `{ baseToken, quoteToken, priceNative, priceUsd,
  liquidity, volume24h, txns24h }`.

### Data sources

- **Phase 1 (skinny)**: computed on-read from pair contract state. USD
  denominator comes from a hardcoded anchor (EGAZ/USD pinned via an
  operator-set config, or derived from a CG-listed stable if one exists
  on an ETX-hub pair). Historical endpoints return the last N
  client-observed samples — good enough for CG/CMC spot, *not* good
  enough for DEX Screener's candle UI.
- **Phase 2 (indexer)**: historical endpoints backed by real OHLCV from
  the indexer DB. Unlocks DEX Screener / GeckoTerminal candle ingestion.

### Aggregator listings

Listing is *not* "ship the API and wait" — each aggregator has its own
submission flow. Rough order of effort (lowest → highest):

1. **GeckoTerminal** — auto-indexes from DEX Screener schema. If our
   `/api/v1/prices/pairs` matches, they pick us up after manual request
   via their "submit a chain" form. Requires a chainlist.org entry for
   Etica (check: do we have one?).
2. **DEX Screener** — same pair schema + chain-submission form. Wants
   volume/TX history, so Phase 2 indexer is a prereq.
3. **CoinGecko** — token-submission form per asset (ETI, EGAZ, ETX),
   requires our `/api/v1/prices/simple` endpoint. Each token requires
   proof-of-project (website, audit, socials), not just code.
4. **CoinMarketCap** — similar to CG but stricter; typically wants CG to
   approve first. 2+ weeks.

### Prereqs that are *not* code

- Chainlist.org entry for Etica mainnet (chain id 61803). Without this,
  aggregators refuse to index. Check status before we commit to listing
  work.
- Logos (SVG + PNG 200x200) for ETI, EGAZ, ETX.
- A project brief (1-pager) for each aggregator's review team.

## What I recommend shipping, in order

1. **F.12.a** — Phase 1 skinny explorer (`/explorer/*`, no indexer). ~1 day.
   Delivers real user value immediately without new infra.
2. **F.12.b** — Price API routes backed by pair-contract reads
   (`/api/v1/prices/simple`, `/api/v1/prices/pairs`). ~0.5 day.
   Unblocks the first round of aggregator submissions.
3. **User task** — chainlist.org submission + logos + CG/CMC/DEX Screener
   project forms. **You own this**; I can draft the project briefs.
4. **F.12.c** (optional) — turn on indexer to Neon/Supabase, back
   historical candles with real data. Only if traction warrants.
5. **F.12.d** (optional) — contract verification.

This order front-loads the visible wins (explorer UI, working price API)
and defers the only expensive piece (indexer hosting) until there's
evidence it's needed.

## Open questions for you

1. Is chainlist.org already set up for Etica mainnet? If not, who submits?
2. Do you already have logos + project briefs for ETI / EGAZ / ETX, or do
   I need to draft them?
3. Is "skinny explorer → price API → aggregator submission" the right
   ordering, or do you want the aggregator work first (to pressure the
   listing timelines) and the explorer second?
4. Any explorer features you specifically want in v1 that aren't listed
   above? (e.g. a dedicated ETX reward / vesting tracker page?)

## Appendix — implementation notes for F.12.a (skinny explorer)

- New folder `apps/web/src/app/explorer/` with one page component per
  route. All components client components (marked `'use client'`) so we
  can use viem hooks directly.
- Reuse `apps/web/src/lib/rpc.ts`'s RPC fallback pattern — the fallback
  logic there was already hardened for the `/admin/reactor` page.
- Reuse `apps/web/src/lib/abis/*` for decoding known contract logs.
- New module `apps/web/src/lib/explorer/decode.ts` — best-effort log
  decoder that walks all known ABIs and returns the first match, plus a
  raw hex fallback.
- No persistent state. Sensible client-side in-memory caching (SWR or
  a small bespoke cache) to avoid hammering RPC.
- No new env vars. Works with the existing `NEXT_PUBLIC_*` RPC config.
