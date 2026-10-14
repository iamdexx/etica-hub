# direct-watcher

An extra pair of eyes on EticaSwap Direct. Every 5 minutes (GitHub Actions cron) it reads the factory and every window and checks:

| check | severity | what it means |
| --- | --- | --- |
| `LP_DECREASED` | critical | a window's hub LP went down — must be impossible (`burn` reverts) |
| `FEE_TO`, `FEE_TO_SETTER`, `DEPLOYER`, `WHITELIST*` | critical | an admin setting differs from `expected.json` |
| `RESERVE_DRIFT` | warning | reported `getReserves` price is > `DIRECT_RESERVE_DRIFT_BPS` off the hub cross price (call `sync()`, or the hub was moved) |
| `TIERS`, `MIN_STETX`, `BASE_FEE`, `GUARDIAN` | warning | gate/ladder drift |
| `PAUSED` | warning | venue is paused (reminder every run) |
| `PRICE_IMPACT`, `ROUND_TRIP` | warning | gaming shapes: a fill > `DIRECT_PRICE_IMPACT_BPS` below the pre-trade price (hub pushed or oversized trade); one wallet trading both directions within `DIRECT_ROUND_TRIP_BLOCKS` blocks (sandwich shape). Never a pause trigger: the hub prices every trade and the gamer pays the tier fee on each leg |
| `LARGE_SWAP`, `LOOSE_TOKENS`, `RETIRED`, `FLIPPING` | info | notable activity |

Findings go to Telegram (`DIRECT_TELEGRAM_*`, falling back to the bridge bot). On any **critical** finding, if `DIRECT_GUARDIAN_PRIVATE_KEY` is set and the venue is not already paused, the watcher calls `factory.pauseSwaps()`. The guardian key can only pause, and its pause lapses after `guardianPauseDuration` (7 days by default) so the watcher can never freeze the venue for good; `unpauseSwaps` is the setter's, after a human has looked. Pausing never traps funds: windows have nothing to withdraw, plain pairs keep mint/burn open.

## Telegram admins

Alerts go to the operators' group (`DIRECT_TELEGRAM_CHAT_ID`, default `-5558279555`). Users listed in `DIRECT_TELEGRAM_ADMIN_IDS` (default `1954950984,1762222862`: Deaven and Ulmo) can message the bot, in the group or by DM: `/status` (pause state, windows, hub LP, open findings), `/pause` (guardian pause via the watcher's key; lapses after `guardianPauseDuration`, only the multisig unpauses) and `/help`. Commands are read on each cron run via `getUpdates`, so expect an answer within ~5 minutes, and there is no `/unpause` on purpose. Use a dedicated bot token (`DIRECT_TELEGRAM_BOT_TOKEN`) because `getUpdates` must not be shared with another poller; set `DIRECT_TELEGRAM_BOT_NAME` so `/status@bot` works in a group with several bots.

State (per-window LP floor, last scanned block, last answered Telegram update) is committed back to the `direct-watcher-state` branch by the workflow so the monotonic check spans runs.

```
pnpm --filter @etica-hub/direct-watcher run watch
```

Env: `DIRECT_RPC_URL`, `DIRECT_FACTORY_ADDRESS` (defaults to `DEPLOYMENTS[61803].directFactory`; zero = skip clean), `DIRECT_GUARDIAN_PRIVATE_KEY`, `DIRECT_RESERVE_DRIFT_BPS` (100), `DIRECT_LARGE_SWAP_BPS` (500), `DIRECT_SCAN_LOOKBACK_BLOCKS` (5000), `DIRECT_PRICE_IMPACT_BPS` (300), `DIRECT_ROUND_TRIP_BLOCKS` (3), `DIRECT_STATE_PATH`, `DIRECT_EXPECTED_PATH`, `DIRECT_TELEGRAM_BOT_TOKEN`, `DIRECT_TELEGRAM_BOT_NAME`, `DIRECT_TELEGRAM_CHAT_ID`, `DIRECT_TELEGRAM_ADMIN_IDS`.
