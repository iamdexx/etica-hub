# direct-watcher

An extra pair of eyes on EticaSwap Direct. Every 5 minutes (GitHub Actions cron) it reads the factory and every window and checks:

| check | severity | what it means |
| --- | --- | --- |
| `LP_DECREASED` | critical | a window's hub LP went down — must be impossible (`burn` reverts) |
| `FEE_TO`, `FEE_TO_SETTER`, `DEPLOYER`, `WHITELIST*` | critical | an admin setting differs from `expected.json` |
| `RESERVE_DRIFT` | warning | reported `getReserves` price is > `DIRECT_RESERVE_DRIFT_BPS` off the hub cross price (call `sync()`, or the hub was moved) |
| `TIERS`, `MIN_STETX`, `BASE_FEE`, `GUARDIAN` | warning | gate/ladder drift |
| `PAUSED` | warning | venue is paused (reminder every run) |
| `LARGE_SWAP`, `LOOSE_TOKENS`, `RETIRED` | info | notable activity |

Findings go to Telegram (`DIRECT_TELEGRAM_*`, falling back to the bridge bot). On any **critical** finding, if `DIRECT_GUARDIAN_PRIVATE_KEY` is set and the venue is not already paused, the watcher calls `factory.pauseSwaps()`. The guardian key can only pause; `unpauseSwaps` is the setter's, after a human has looked. Pausing never traps funds: windows have nothing to withdraw, plain pairs keep mint/burn open.

State (per-window LP floor, last scanned block) is committed back to the `direct-watcher-state` branch by the workflow so the monotonic check spans runs.

```
pnpm --filter @etica-hub/direct-watcher run watch
```

Env: `DIRECT_RPC_URL`, `DIRECT_FACTORY_ADDRESS` (defaults to `DEPLOYMENTS[61803].directFactory`; zero = skip clean), `DIRECT_GUARDIAN_PRIVATE_KEY`, `DIRECT_RESERVE_DRIFT_BPS` (100), `DIRECT_LARGE_SWAP_BPS` (500), `DIRECT_SCAN_LOOKBACK_BLOCKS` (5000), `DIRECT_STATE_PATH`, `DIRECT_EXPECTED_PATH`.
