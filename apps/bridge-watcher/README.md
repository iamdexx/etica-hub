# @etica-hub/bridge-watcher

Free, GitHub-Actions-only watcher for the Phase 3 ETX bridge.

Three jobs, one per workflow file. Default cadence:

| Job | Cadence | What it does |
|---|---|---|
| `heartbeat` | every 15 min | Calls `BridgeMinter.heartbeat()` on each remote chain so the on-chain `HeartbeatISM` keeps accepting inbound deposits. The 4h auto-pause threshold gives ~16 successful runs of margin. |
| `monitor`   | every 5 min  | Pulls recent `ClaimSubmitted` events from each remote and verifies each one against the source-of-truth `Deposit` event on Etica. Posts a Telegram alert on any mismatch. **Does not auto-veto** — operator pushes `vetoClaimManual` from a hardware wallet within the 48h window. |
| `execute`   | every 30 min | Calls `executeClaim(nonce)` on matured legitimate claims so end users do not pay destination-chain gas. Refuses to execute (and alerts) if the matured claim does not match its Etica deposit. |

Operating cost: **$0 / month**. GitHub Actions free tier covers all three crons on a public repo.

## Why no auto-veto

A compromised watcher key with auto-veto authority would be a denial-of-service vector — the attacker could veto every legitimate claim. The watcher therefore only **alerts**; the veto button stays on a hardware wallet held by the operator (`vetoAuthority` on each `BridgeMinter`). The 48h challenge window is long enough that human-in-the-loop review is operationally feasible.

The `heartbeat` and `execute` keys are intentionally low-privilege:

- `heartbeat` EOA is just `heartbeatSigner` on each minter — its only on-chain ability is to refresh a timestamp. If it leaks, rotate via the timelocked `requestSetHeartbeatSigner` op.
- `execute` EOA has no role at all. `executeClaim` is permissionless on-chain; this key just pays gas. If it leaks, fund a new one and rotate the secret.

## Configuration

All knobs are env-var driven so workflows can be tuned without code changes.

| Variable | Required | Notes |
|---|---|---|
| `BRIDGE_ETICA_RPC_URL` | required | Defaults to `https://rpc2.etica-stats.org`. |
| `BRIDGE_VAULT_ADDRESS` | required for sanity-check | Etica `BridgeVault` deploy address. |
| `BRIDGE_MINTER_ETH_ADDRESS` | one of (eth/bnb) | Ethereum `BridgeMinter` deploy address. Unset = skip Eth side. |
| `BRIDGE_ETH_RPC_URL` | optional | Defaults to a publicnode endpoint. |
| `BRIDGE_ETH_DOMAIN` | optional | Hyperlane domain ID, default `1`. |
| `BRIDGE_MINTER_BNB_ADDRESS` | one of (eth/bnb) | BNB `BridgeMinter` deploy address. Unset = skip BNB side. |
| `BRIDGE_BNB_RPC_URL` | optional | Defaults to a publicnode endpoint. |
| `BRIDGE_BNB_DOMAIN` | optional | Hyperlane domain ID, default `56`. |
| `BRIDGE_HEARTBEAT_PRIVATE_KEY` | required for heartbeat | EOA matching `heartbeatSigner` on each minter. |
| `BRIDGE_EXECUTE_PRIVATE_KEY` | required for execute | Any funded EOA — no on-chain role. |
| `BRIDGE_TELEGRAM_BOT_TOKEN` | optional | Reuse the buybot token or use a separate bot. |
| `BRIDGE_TELEGRAM_CHAT_ID` | optional | Operator-private chat — different from the public buy-bot channel. |
| `BRIDGE_SCAN_LOOKBACK_BLOCKS` | optional | Default `5000`. Raise on fast chains (e.g. BNB ~3s blocks). |

If a remote's minter address is unset, the watcher silently skips that remote and exits 0. CI stays green from day-zero through deploy day.

## Local dev

```bash
pnpm --filter @etica-hub/bridge-watcher run heartbeat
pnpm --filter @etica-hub/bridge-watcher run monitor
pnpm --filter @etica-hub/bridge-watcher run execute
```

All three are one-shot scripts. Set env vars on the command line or in `.env` (loaded by `dotenv` at the workflow level — local dev can use `pnpm exec dotenv-cli`).

## Pairing with the runbook

This watcher implements the day-2 monitoring sections of [`docs/BRIDGE_OPS_RUNBOOK.md`](../../docs/BRIDGE_OPS_RUNBOOK.md):

- §3.2 Heartbeat monitoring → `heartbeat` job
- §3.3 Sanity-check loop → `monitor` job
- §3.4 Auto-execute matured claims → `execute` job

Manual veto, cap rotation, and successor-key activation remain out of scope for the watcher (per design — those are operator hardware-wallet flows).
