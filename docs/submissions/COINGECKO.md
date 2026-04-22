# CoinGecko — Submission Brief

## Status

| Asset | Listed? | CoinGecko slug |
|---|---|---|
| ETI | ✅ yes | [`etica`](https://www.coingecko.com/en/coins/etica) |
| EGAZ | ✅ yes | [`egaz`](https://www.coingecko.com/en/coins/egaz) |
| ETX | ❌ no | (submit) |
| EticaSwap DEX | ❌ no | (submit) |

Two submissions needed: a **new coin** (ETX) and a **new DEX** (EticaSwap).

## Forms to open

1. **Coin request (ETX):** https://www.coingecko.com/en/coins/new (requires
   CoinGecko account; free. "Submit a coin" → "Add new crypto asset").
2. **DEX request (EticaSwap V2):** https://www.coingecko.com/en/dexes/new
   (same account, "Submit a DEX" flow).

Both forms are reviewed by the CoinGecko team; typical turnaround is 1–4
weeks depending on queue.

## Submission 1 — ETX (coin)

### Required fields — copy/paste

- **Project Name:** EticaHub Token
- **Symbol:** ETX
- **Coin Type:** Token (ERC-20)
- **Platform / Blockchain:** Etica Mainnet (EVM, chain id 61803)

  > If Etica Mainnet doesn't appear in the "Platform" dropdown, select "Other"
  > and write `Etica Mainnet (EVM chain id 61803)` in the free-text field.
  > Reference: https://chainlist.org/chain/61803 confirms it's a registered
  > EVM chain, and ETI and EGAZ are already on CoinGecko — so the platform is
  > effectively recognized, just possibly not yet in the dropdown.

- **Contract Address:** `0xa5A1Bc6307b0b87989B8456D4b35F88a68650044`
- **Decimals:** 18
- **Contract explorer link:**
  `https://eticascan.org/address/0xa5A1Bc6307b0b87989B8456D4b35F88a68650044`
  and `https://eticahub.com/explorer/address/0xa5A1Bc6307b0b87989B8456D4b35F88a68650044`
- **Total supply:** `100000000` (fixed at deploy; paste the live value from
  https://eticahub.com/api/v1/supply/total?token=etx). The endpoint returns a
  single plain-text number — ready for CoinGecko's "Total Supply API URL"
  field as-is.
- **Circulating supply:** paste live value from
  https://eticahub.com/api/v1/supply/circulating?token=etx (total minus the
  POL-burn balance at `0x000000000000000000000000000000000000dEaD`). Again:
  plain-text single number, paste directly into the "Circulating Supply API
  URL" field.
- **Burned supply (optional, for "Max Supply – Burned" disclosure):**
  https://eticahub.com/api/v1/supply/burned?token=etx
- **Full rich snapshot (supply + spot prices + metadata) for reference:**
  https://eticahub.com/api/v1/tokens/etx

### Project metadata

- **Website:** `https://eticahub.com`
- **Whitepaper:** `https://eticahub.com/whitepaper`
- **Source code:** `https://github.com/iamdexx/etica-hub`
- **Twitter / X:** (fill in project X handle)
- **Discord:** `https://discord.com/invite/5QyKhENXgb`
- **Short description (≤140 chars):**
  > EticaHub Token (ETX) is the governance and fee-discount token for EticaHub, the non-custodial DEX + trading-bot suite on Etica Protocol.
- **Long description (paste):**
  > EticaHub is a non-custodial DeFi suite on the Etica Protocol blockchain
  > (chain id 61803, native coin EGAZ). It includes EticaSwap (Uniswap V2-style
  > AMM with an ETX hub-and-spoke pair graph), on-chain limit/stop/DCA/grid
  > orders via a UniswapX DutchOrderReactor fork, a permissionless on-chain
  > OrderRegistry, and a public price & market-data API at
  > https://eticahub.com/api/v1 (CoinGecko-compatible endpoints).
  >
  > ETX is the project's governance and rewards token. It pairs with every
  > other asset on EticaSwap (hub-and-spoke), is the denomination of protocol
  > fees collected by the DutchOrderReactor, and distributes to liquidity
  > providers via the MasterChef rewards contract.

### Price source

CoinGecko needs at least one market price source. Options:

- **Preferred:** reference our public API. ETX/ETX is always 1, but the two
  real pairs are:
  - `ETX/WEGAZ` on EticaSwap: pool address returned from
    `https://eticahub.com/api/v1/pairs?token=ETX&vs=EGAZ`
  - `ETX/ETI` on EticaSwap: same query with `vs=ETI`.
- Alternative: point to any centralized exchange that lists ETX (none as of
  this writing — leave blank if so).

### Logos & assets

CoinGecko requires:
- PNG 200×200 logo for the coin
- Preferably SVG as well

Both live at:
- https://eticahub.com/etx-logo-200.png (200×200 PNG)
- https://eticahub.com/etx-logo-512.png (512×512 PNG — for CMC / DEX Screener)
- https://eticahub.com/etx-logo.svg (vector)

## Submission 2 — EticaSwap V2 (DEX)

### Required fields — copy/paste

- **DEX name:** EticaSwap V2
- **DEX URL:** `https://eticahub.com/swap`
- **Chain:** Etica Mainnet (chain id 61803)
- **DEX type:** AMM (Uniswap V2 fork; ETX hub-and-spoke enforced at factory)
- **Factory contract:** `0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3`
- **Router contract:** `0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723`
- **Pair contract ABI:** Uniswap V2 Pair (standard). Events we emit:
  - `Sync(uint112 reserve0, uint112 reserve1)`
  - `Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)`
  - `Mint` / `Burn` (standard V2)
- **Factory event for new pairs:**
  `PairCreated(address indexed token0, address indexed token1, address pair, uint256)`
- **Public API endpoint CoinGecko can poll:**
  `https://eticahub.com/api/v1/pairs` (returns every pair + reserves +
  ETX-denominated spot) — see `docs/PRICE_API.md` for schema.

### Sample pairs to include

(Fetch live list from `https://eticahub.com/api/v1/pairs` on submission day —
we seeded at least these three at launch:)
- ETX/WEGAZ
- ETX/ETI
- ETX/(first launchpad token)

## Proof-of-ownership checklist

CoinGecko will usually ask for one of:
1. Post the submission token on the project's official Twitter/X referencing
   the submission.
2. Email from a mailbox on `@eticahub.com`.
3. Sign a short message from the treasury wallet
   (`0xB2B4bC9d02970A55efF64C2D84c622c87967C19D`) via
   `https://etherscan.io/verifiedSignatures` — they accept Etica-chain
   signatures since only the signature itself matters, not the chain.

Pick whichever is easiest; option 3 is fastest because it doesn't touch
external accounts.
