# Aggregator Submission Briefs — F.12 Follow-up

This doc collects **everything needed to submit EticaHub and the Etica chain to
external price/market-data aggregators**. Each brief is written to be
copy-pasted into the aggregator's submission form with minimal editing.

## Who submits

**You** (the EticaHub project owner controlling `eticahub.com` and the
treasury wallet). Every aggregator below requires:
- A submitter email on the project domain, AND
- The ability to sign a statement or respond from an official social channel.

Devin cannot submit on your behalf without spoofing ownership, so this doc is
the handoff. Work the four sections in order — they're ordered by expected
time-to-first-listing (shortest first).

## What's already done (no submission required)

### Chainlist.org — ALREADY LISTED

Etica Mainnet (chain id 61803) is already in the DefiLlama
[`ethereum-lists/chains`](https://github.com/ethereum-lists/chains/tree/master/_data/chains)
dataset that powers chainlist.org:

  https://chainlist.org/chain/61803

No further action needed unless you want to add a third RPC URL or update the
metadata (e.g. new icon). If so, the PR goes against
[`ethereum-lists/chains`](https://github.com/ethereum-lists/chains) editing
`_data/chains/eip155-61803.json`.

## What's partially done

### CoinGecko — **ETI ✅, EGAZ ✅, ETX ❌, EticaSwap DEX ❌**

Etica's core assets are already listed on CoinGecko:
- [ETI](https://www.coingecko.com/en/coins/etica) — via Etica Protocol team
- [EGAZ](https://www.coingecko.com/en/coins/egaz)

But EticaHub's own assets and the EticaSwap DEX are **not**:
- ETX (governance/rewards token): `0xa5A1Bc6307b0b87989B8456D4b35F88a68650044`
- EticaSwap (DEX, our factory): `0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3`

See [`submissions/COINGECKO.md`](./submissions/COINGECKO.md) for the two
submissions to open.

### CoinMarketCap — **ETI ✅, EGAZ ❌ likely, ETX ❌**

Only ETI is confirmed listed:
- [ETI](https://coinmarketcap.com/currencies/etica/)

EGAZ and ETX both need submissions. See
[`submissions/COINMARKETCAP.md`](./submissions/COINMARKETCAP.md).

## What needs new submissions

### DEX Screener — **Etica chain not supported**

DEX Screener tracks ~20 chains today and Etica isn't one of them. Listing
requires a chain-integration request (higher bar than a single-token listing):
they add a chain once the project provides a reliable RPC, factory address,
pair-created event signature, and a sample of active pairs with real volume.

See [`submissions/DEX_SCREENER.md`](./submissions/DEX_SCREENER.md).

### GeckoTerminal — **Etica chain not supported**

GeckoTerminal supports ~267 chains (Solana/EVM/non-EVM) and auto-indexes DEXes
on any chain that CoinGecko's backend indexes. Etica isn't indexed yet, but
because CoinGecko already tracks ETI and EGAZ as single tokens, the infra
hurdle is smaller than DEX Screener — they mostly need the factory contract
and an RPC they can poll.

See [`submissions/GECKOTERMINAL.md`](./submissions/GECKOTERMINAL.md).

## Shared project metadata (paste-ready for every form)

The per-aggregator briefs reference these canonical values. Update them here
if anything changes upstream (don't edit copies in the briefs).

| Field | Value |
|---|---|
| Project name | EticaHub |
| Tagline | DEX + non-custodial trading bots on Etica Protocol |
| Website | https://eticahub.com |
| Whitepaper | https://eticahub.com/whitepaper |
| Explorer (ours) | https://eticahub.com/explorer |
| Explorer (chain-level) | https://eticascan.org |
| Public price/market API | https://eticahub.com/api/v1 |
| API docs | [`docs/PRICE_API.md`](./PRICE_API.md) + `https://eticahub.com/api/v1/stats` |
| GitHub | https://github.com/iamdexx/etica-hub |
| Twitter/X | (fill in) |
| Discord | https://discord.com/invite/5QyKhENXgb (Etica Protocol) |
| Chain ID | 61803 (hex `0xf16b`) |
| Chain name | Etica Mainnet |
| Native coin | EGAZ (18 decimals) |
| RPCs | `https://eticamainnet.eticascan.org`, `https://eticamainnet.eticaprotocol.org`, `https://61803.rpc.thirdweb.com` |
| Genesis | 2021-10-16 |

### Contract addresses (Etica Mainnet, 61803)

| Contract | Address |
|---|---|
| ETI (Etica Protocol, not ours) | `0x34c61EA91bAcdA647269d4e310A86b875c09946f` |
| ETX (EticaHub governance/rewards) | `0xa5A1Bc6307b0b87989B8456D4b35F88a68650044` |
| WEGAZ (wrapped EGAZ) | `0x232fb2B87CAce92B2438054A7eB79B4081E3E11a` |
| EticaSwap V2 Factory | `0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3` |
| EticaSwap V2 Router | `0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723` |
| Permit2 | `0x165F71f549415f44883e370Df12169Dd99570eE5` |
| DutchOrderReactor (UniswapX fork) | `0xE2fc7EAcEB0146560bfcf46CC5B167df60E970B8` |
| ETX ProtocolFeeController | `0xB9a4FbfC4cA598Be18e09bb9C0Cf19e4a1A4350a` |
| OrderRegistry (on-chain orderbook) | `0xA6f3e48Cf31DcE3a8d36659f5bC6a61785c404a9` |
| Treasury / multisig | `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D` |

### EticaSwap V2 ABI surface (for integrators)

Identical to Uniswap V2, with the ETX-hub-and-spoke restriction enforced at the
factory:
- Factory event: `PairCreated(address indexed token0, address indexed token1, address pair, uint256)`
- Pair event: `Sync(uint112 reserve0, uint112 reserve1)` (what our public API and the `/trade/*` chart already consume)
- Pair event: `Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)`

## Blockers you'll need to resolve before submitting

1. **Logos.** Every aggregator requires a 200×200 PNG (some also want SVG).
   Needed for: ETX, WEGAZ, and — if you want a custom chain icon — EGAZ and
   the Etica-Mainnet chain page. If you don't have these yet, generate them
   first; without them, several submissions can't be completed.

2. **Audit (optional but helps).** CMC and CoinGecko both have an "audit
   reports" field. Leaving it blank is allowed but slows review. If you have
   any audit (even internal), upload it; if not, state "unaudited" honestly.

3. **Social proof.** Both CG and CMC verify ownership through a short post
   from the project's official Twitter or Discord referencing a
   submission-specific string they generate. Have access to one of those
   accounts when you start the form.

## Order of operations (suggested)

1. Open all four submission pages in tabs, skim the forms, note which fields
   each one blocks on that you can't fill yet (usually: logos).
2. Fix blockers (produce logos if missing; decide on an audit stance).
3. Submit CoinMarketCap (EGAZ + ETX) and CoinGecko (ETX) same day — shortest
   turnaround (days–weeks), smallest scope.
4. Submit the EticaSwap DEX on CoinGecko's DEX form — needed before
   GeckoTerminal will auto-index pairs.
5. Submit DEX Screener chain-integration request — longer turnaround
   (weeks–months).
6. Submit GeckoTerminal chain-integration request — often resolved via the
   CoinGecko submission in step 4.

## What Devin can NOT do

- Submit any of these forms from `eticahub.com` domain or treasury wallet —
  aggregators will detect the mismatch and reject the submission.
- Sign ownership proofs.
- Produce logos (no design tooling on the session VM today).

## What Devin CAN do next (ping to queue)

- Add `/api/v1/ohlcv/[pair]` (15m/1h/4h/1d candle history) — DEX Screener and
  GeckoTerminal both ask for historical candles, and we could back-derive them
  from `Sync` events without an indexer for the last N days.
- Add `/api/v1/pools` in GeckoTerminal's CoinGecko-compatible pools format
  (superset of the `/api/v1/pairs` we ship today).
- Add a `/status` API check for aggregator bots (`/api/v1/health` returning
  head-block age + RPC reachability).
- Generate 200×200 SVG-to-PNG placeholder logos for ETX/WEGAZ that you can
  replace with real art later.

Say the word on any of those and I'll ship in a follow-up.
