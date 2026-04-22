# EticaHub Telegram Buy Bot

Per-swap Telegram announcements for every buy on the EticaHub DEX.
The bot lives inside `apps/web` as a Vercel Cron route
(`/api/cron/buybot`) so it runs on the same deploy, shares the same RPC
config, and incurs zero extra infrastructure cost.

## What it posts

Every minute the cron:

1. Reads `lastScannedBlock` from Vercel KV / Upstash Redis.
2. Enumerates every pair on the EticaHub factory (hub-and-spoke: every
   pair contains ETX).
3. Fetches `Swap` events across those pairs for
   `(lastScannedBlock, latestBlock]` (capped at `BUYBOT_MAX_BLOCKS_PER_RUN`).
4. Derives prices and market caps:
   - Token-to-token price from pool reserves at the swap's block.
   - ETI and EGAZ USD prices from NonKYC's public ticker API.
   - ETX USD price = (ETX/ETI reserves) × ETI/USDT, or the same with EGAZ
     when the pool is ETX/EGAZ.
   - Market cap = `totalSupply * tokenUsdPrice`, computed for both sides.
5. Posts a compact HTML message per swap with the bought token, amount,
   USD notional, price (in both the paired token and USD), both market
   caps, and a direct explorer link.
6. Writes the new cursor back to KV.

Example message:

```
🟢 ETI Buy on EticaHub

💸 Swap   2.5k ETX → 100 ETI
💵 Value  $2.50
📊 Price  1 ETI = 25 ETX  ($0.025)

🧢 MC ETI   $525.00k
🧢 MC ETX   $100.00k

🔗 view tx  ·  block 1234567
```

## Deployment

### 1. Provision a Vercel KV (or Upstash Redis) store

Vercel dashboard → Storage → Create → KV → attach to the web project.
Vercel auto-populates `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

Alternatively, point the bot at any Upstash Redis database via the
equivalent `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.

### 2. Create the Telegram bot

- Message `@BotFather`, run `/newbot`, note the HTTP API token.
- Create a public / private channel, add the bot as an **admin** (it
  needs "post messages" at minimum).
- Post any message in the channel, then call
  `https://api.telegram.org/bot<token>/getUpdates` and copy the
  `channel_post.chat.id` value (channels are typically negative numbers
  starting with `-100`).

### 3. Set Vercel env vars

Required:

| Variable | Purpose |
|---|---|
| `BUYBOT_TELEGRAM_BOT_TOKEN` | The HTTP API token from BotFather. |
| `BUYBOT_TELEGRAM_CHAT_ID` | Destination channel/group id. |
| `KV_REST_API_URL` | KV cursor store URL. |
| `KV_REST_API_TOKEN` | KV bearer token. |

Optional:

| Variable | Default | Purpose |
|---|---|---|
| `BUYBOT_RPC_URL` | `ETICA_MAINNET_RPC_URL` | Dedicated RPC for the bot. |
| `BUYBOT_EXPLORER_BASE_URL` | `https://eticahub.org` | Base URL for tx links. |
| `BUYBOT_MIN_USD_TO_POST` | `1` | Drop swaps below this USD notional. |
| `BUYBOT_MAX_BLOCKS_PER_RUN` | `2000` | Safety cap on catch-up scans. |
| `BUYBOT_NONKYC_API_URL` | `https://api.nonkyc.io` | USD oracle. |
| `BUYBOT_KV_NAMESPACE` | `buybot:v1` | KV key prefix. |
| `CRON_SECRET` | `null` | If set, the route requires a `Authorization: Bearer $CRON_SECRET` header (Vercel's crons do this automatically). |

### 4. Verify

After the next cron tick (≤ 60 seconds), hit
`https://<your-domain>/api/cron/buybot?debug=1` with the cron secret —
the response body includes `{ ok, window, scanned, posted, skipped }`.

Vercel's cron dashboard under *Settings → Crons* shows past runs and
their durations.

## Behaviour notes

- On first deploy (no cursor in KV) the bot only looks back ~50 blocks
  (~4 minutes on Etica's 5s blocktime), so the channel doesn't instantly
  flood with historical buys.
- If the cron misses a run (Vercel maintenance, deploy window), the next
  run catches up to at most `BUYBOT_MAX_BLOCKS_PER_RUN` blocks. A wider
  outage requires manually bumping the cursor or temporarily lifting the
  cap.
- Swaps that can't be priced (e.g. new launchpad tokens with no USD
  anchor path) still post, with `—` for the USD figures.
- The route is **idempotent against a frozen chain** but not against
  concurrent invocations. Vercel guarantees cron serialization, so this
  is fine in production.

## Development

```bash
pnpm --filter @etica-hub/web dev
# In another terminal, trigger a single run:
curl "http://localhost:3000/api/cron/buybot"
```

Without KV credentials in dev, the route falls back to an in-memory KV
(resets on every dev-server restart) and refuses to run in production.
