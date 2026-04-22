# CoinMarketCap — Submission Brief

## Status

| Asset | Listed? | CMC slug |
|---|---|---|
| ETI | ✅ yes | [`etica`](https://coinmarketcap.com/currencies/etica) |
| EGAZ | ❌ likely no | (submit) |
| ETX | ❌ no | (submit) |

Two submissions needed: **EGAZ** (native coin of Etica Mainnet) and **ETX**
(EticaHub governance token).

## Form

**CMC Request Form (single form, choose "Cryptocurrency"):**
https://support.coinmarketcap.com/hc/en-us/requests/new?ticket_form_id=360000493112

Select **"Add Cryptocurrency to CoinMarketCap"**. You'll need a free Zendesk /
CMC account. Typical turnaround 1–3 weeks.

## Submission 1 — ETX

### Required fields — copy/paste

- **Cryptocurrency Name:** EticaHub Token
- **Ticker Symbol:** ETX
- **Launch Date:** (date of first transfer out of treasury — check the
  explorer: `https://eticahub.com/explorer/address/0xa5A1Bc6307b0b87989B8456D4b35F88a68650044`)
- **Max Supply:** (from the token contract's `totalSupply()` — ETX is mintable
  to MasterChef but issuance is capped in the whitepaper; cite the cap)
- **Total Supply:** (live value from the contract or our API)
- **Circulating Supply:** (total minus locked vesting balances; cite what's
  locked at treasury/multisig)
- **Initial Distribution:** See Section 4 of the whitepaper
  (`https://eticahub.com/whitepaper`)
- **Project Type:** DeFi / Governance token
- **Platform:** Etica Mainnet (EVM, chain id 61803)

  > CMC usually doesn't pre-populate Etica Mainnet. In the "Platform" field,
  > write `Etica Mainnet` and in the "Contract address" field paste the ETX
  > address. In a free-text note, mention "Chain id 61803 — listed on
  > chainlist.org, see https://chainlist.org/chain/61803".

- **Contract Address:** `0xa5A1Bc6307b0b87989B8456D4b35F88a68650044`
- **Explorer link:** `https://eticahub.com/explorer/address/0xa5A1Bc6307b0b87989B8456D4b35F88a68650044`

### Project metadata

- **Website:** `https://eticahub.com`
- **Whitepaper:** `https://eticahub.com/whitepaper`
- **Source Code:** `https://github.com/iamdexx/etica-hub`
- **Twitter:** (fill in)
- **Telegram:** `https://t.me/eticaprotocol`
- **Discord:** `https://discord.com/invite/5QyKhENXgb`
- **Description (paste):**
  > EticaHub Token (ETX) is the governance and rewards token of EticaHub, a
  > non-custodial DeFi suite on the Etica Protocol blockchain (chain id
  > 61803). EticaHub includes EticaSwap (a Uniswap V2-style AMM with an ETX
  > hub-and-spoke pair graph), on-chain limit/stop/DCA/grid orders via a
  > UniswapX DutchOrderReactor fork, a permissionless on-chain OrderRegistry
  > for gasless settlement, and a public market-data API at
  > https://eticahub.com/api/v1 (CoinGecko-compatible endpoints). ETX pairs
  > with every other asset on the DEX, denominates protocol fees, and is
  > distributed to liquidity providers by MasterChef.

### Markets / price source

CMC requires at least one active market. Acceptable options (any one is
enough for initial listing):
- Our public pair endpoint: `https://eticahub.com/api/v1/pairs?token=ETX`
- Direct pair link in our app: `https://eticahub.com/swap?from=ETX&to=WEGAZ`
- Any centralized exchange that lists ETX (none as of writing — skip if so)

### Logos

CMC requires a 200×200 PNG logo for the token. If not ready, hold the
submission until it is — CMC tends to auto-reject without a logo.

## Submission 2 — EGAZ

EGAZ is the **native coin of Etica Mainnet** (analogous to ETH on Ethereum),
not a token on another chain. Its "contract address" on Etica is effectively
the zero address / native; its only ERC-20 form is the wrapped WEGAZ.

### Required fields — copy/paste

- **Cryptocurrency Name:** EGAZ
- **Ticker Symbol:** EGAZ
- **Launch Date:** 2021-10-16 (Etica Mainnet genesis — source: `etica_genesis.json`,
  `timestamp: 0x616bb268`)
- **Max Supply:** Unbounded (Etica Mainnet is PoW, continuous issuance). Cite
  current block reward from `etica_genesis.json`.
- **Total Supply / Circulating:** Fetch live from `https://eticascan.org`
  homepage stats on submission day.
- **Project Type:** Native coin of a PoW EVM chain
- **Platform:** N/A (EGAZ **is** the native coin of Etica Mainnet 61803)
- **Contract Address:** N/A — provide the **WEGAZ** address as a "related
  token" instead: `0x232fb2B87CAce92B2438054A7eB79B4081E3E11a`
- **Explorer link:** `https://eticascan.org` and `https://eticahub.com/explorer`

### Project metadata

- **Website:** `https://www.eticaprotocol.org` (canonical) and
  `https://eticahub.com` (for DEX/DeFi surface)
- **Whitepaper:** `https://www.eticaprotocol.org/eticadocs/howitworks`
- **Source Code:** `https://github.com/etica/core-geth`
- **Description (paste):**
  > EGAZ is the native gas coin of Etica Mainnet (EVM chain id 61803), a PoW
  > blockchain launched in October 2021. It pays transaction fees on Etica,
  > and its wrapped ERC-20 form WEGAZ
  > (`0x232fb2B87CAce92B2438054A7eB79B4081E3E11a`) is the primary quote asset
  > on EticaSwap (alongside ETX). Etica Mainnet also hosts ETI, the Etica
  > Protocol research-reward token.

### Markets

- WEGAZ paired against ETX on EticaSwap:
  `https://eticahub.com/swap?from=WEGAZ&to=ETX`
- EGAZ on centralized exchanges: Xeggex, NonKYC, TradeOgre, SafeTrade
  (references from
  https://linktr.ee/eticaprotocol — include all four as markets).

### Logos

200×200 PNG. EGAZ has no published logo that I could find — you likely need
to produce one. The Etica Protocol team (reachable via Discord /
@eticaprotocol on X) may have an official asset they can share.

## Proof-of-ownership checklist

CMC typically asks for:
1. A post from the project's official Twitter referencing the submission ID.
2. Ownership signature from the contract's deployer / owner wallet. For ETX,
   this is the treasury at
   `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D`; sign a short message
   prepared by CMC.
3. For native coins, CMC usually asks for a PR or official post from the
   chain's maintainer account (in this case Etica Protocol) endorsing the
   submission — coordinate with the Etica team on this one.

## Pitfall to avoid

CMC auto-rejects submissions that lack liquidity on the listed markets. If
ETX has less than a few hundred dollars of ETX/WEGAZ liquidity on EticaSwap
at submission time, seed more liquidity before submitting — otherwise the
review bot will flag "insufficient market depth" and you'll have to redo the
form.
