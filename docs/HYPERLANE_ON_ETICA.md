# Deploying Hyperlane on Etica

Etica (chain id `61803`) isn't in the canonical
[hyperlane-xyz/hyperlane-registry](https://github.com/hyperlane-xyz/hyperlane-registry)
today. Hyperlane is permissionless to deploy, so we run the deploy
ourselves: this is a hard prerequisite for the Phase 3 ETX bridge
since `BridgeVault` immutably stores the Etica `Mailbox` address.

This is the **prose runbook** explaining what each step does and why.
The actual automation lives at
[`apps/hyperlane-validator/`](../apps/hyperlane-validator/) — read
that bundle's `README.md` for the click-by-click invocation.

## Why the bridge needs this

`BridgeVault` (Etica side) and `BridgeMinter` (Eth + BNB side) both
dispatch outbound messages through their local `IMailbox` and validate
inbound messages against an `IInterchainSecurityModule`. On Eth + BNB
those mailboxes are part of the canonical Hyperlane V3 deployment.
On Etica, no canonical mailbox exists — we have to deploy one.

Without it:

- `BridgeVault` constructor reverts (mailbox is immutable, can't be
  zero-address).
- `BridgeMinter` on Eth/BNB dispatches its outbound burn-receipt
  messages to a non-existent destination, blocking withdrawals.
- The community fraud-prover layer (`FraudProverModule.publishRoot`)
  needs an Etica validator set committing to roots; without one
  it's non-functional.

## Topology

| Process | Where | What it does |
|---|---|---|
| `Mailbox` (Etica) | On-chain, deployed by `hyperlane core deploy` | Receives outbound dispatches from `BridgeVault`; emits `Dispatch` events; verifies inbound messages from Eth/BNB |
| Validator daemon | VPS (Hetzner CX22) | Watches Etica `Mailbox.MerkleTreeHook` for new committed roots, signs them, posts signatures to R2 |
| Relayer daemon | Same VPS | Reads validator signatures from R2, delivers inbound messages to all 3 chains, pays gas in native token on each |
| Cloudflare R2 bucket | Cloudflare edge | Public read; validator write. Stores signed checkpoints. Anyone can verify the validator signed a given root by fetching from this URL. |

Single VPS holds both daemons because cost matters and they don't
need redundancy at v1 launch. Bridge defense-in-depth (48h challenge
window, operator veto authority, rate limits) is the substantive
security layer; validator-uptime SPOF is a UX issue, not a security
one (a stalled validator just means inbound deposits stall; the
on-chain `HeartbeatISM` auto-pauses inbound after 4h of silence).

## Cost model

| Item | Frequency | Cost |
|---|---|---|
| Hetzner CX22 (2 vCPU / 4 GB / 40 GB SSD) | recurring | €4.50/mo |
| Cloudflare R2 storage + reads | recurring | $0/mo (free tier) |
| Etica deploy gas (~10 contracts) | one-time | ~5–10 EGAZ |
| Eth `validatorAnnounce` tx | one-time | ~$1–5 |
| BNB `validatorAnnounce` tx | one-time | ~$0.05 |
| Relayer delivery gas (Eth, BNB, Etica) | per-message | passed through to bridge fee revenue |

Total recurring: **~$5/mo**, fully covered by the bridge's 0.1% fee
(80% routes to harvester / treasury per
[`docs/BRIDGE_DESIGN.md`](./BRIDGE_DESIGN.md) §4 step 1.3).

## Phase H — pre-bridge sequence

`docs/BRIDGE_DEPLOY_WALKTHROUGH.md` Phases 0–6 assume Hyperlane is
already up. The Phase H sub-sequence below sits in front of Phase 0.

### H-1: provision infrastructure

```bash
cd apps/hyperlane-validator
cp .env.example .env
# fill in HETZNER_API_TOKEN, CLOUDFLARE_API_TOKEN,
# CLOUDFLARE_ACCOUNT_ID, ETICA_HYPERLANE_DEPLOYER_KEY,
# BRIDGE_OWNER_ADDRESS

./scripts/provision-hetzner.sh   # creates VPS, writes VPS_IP back to .env
./scripts/setup-r2.sh            # creates bucket, writes R2 keys back to .env
```

### H-2: deploy core contracts on Etica

```bash
./scripts/deploy-core.sh
```

Broadcasts ~10 contracts: `Mailbox` proxy + impl, `ProxyAdmin`,
`ValidatorAnnounce`, `InterchainGasPaymaster` proxy + impl,
`MerkleTreeHook`, `ProtocolFee`, `TrustedRelayerIsm`. Costs ~5–10 EGAZ.

The deploy reads:
- `ETICA_HYPERLANE_DEPLOYER_KEY` for tx signing
- `BRIDGE_OWNER_ADDRESS` as the `owner` of every deployed contract

After the deploy, ownership is **already** with `BRIDGE_OWNER_ADDRESS`
— the deployer key is a single-use EOA and gets retired immediately.

Output: `~/.hyperlane/chains/etica/addresses.yaml` containing the
mailbox + IGP + ValidatorAnnounce addresses. The bundle copies this
to `apps/hyperlane-validator/configs/etica-deploy.yaml` and patches
`configs/agent-config.json` so the daemons can use it.

### H-3: bring up validator + relayer

```bash
./scripts/install-on-vps.sh
```

SSHes into the VPS, installs Docker, copies the Compose bundle +
agent config + monitor script, writes a clean runtime `.env` with
only the values the daemons need, runs `docker compose up -d`, and
installs the 15-min monitor cron.

Validator daemon connects to Etica RPC and the R2 bucket; starts
signing roots within ~30s. Relayer daemon connects to all 3 chains
and starts polling for messages.

### H-4: smoke test

```bash
./scripts/smoke-test.sh
```

Sends one Hyperlane test message Etica → Ethereum and one Etica → BNB.
Each is dispatched on Etica, signed by the validator, picked up by
the relayer, and delivered to the destination chain's mailbox. Round
trip is ~30s–2min depending on Eth gas conditions.

If the Eth one takes longer than 5 min: relayer probably ran out of
ETH for delivery gas. Top up the relayer EOA with another 0.05 ETH.

### H-5: 2-3 day soak

Don't move to Phase 0 of the bridge walkthrough yet. Watch the
validator + relayer for 2-3 days:

- Validator should be writing one signed checkpoint to R2 every few
  blocks (every ~30s of validator clock time, ~14s of Etica clock
  time, since the validator queues dispatches into the merkle tree
  and signs checkpoints on a cadence).
- Relayer should be idle most of the time (no real messages flowing
  yet). Send 5–10 manual smoke-test messages over the 2-3 days and
  confirm each one is delivered.
- Telegram monitor should have zero alerts.

The `monitor.sh` cron + Hetzner's monthly billing both count as
ground-truth signals. If neither alerts in 48-72h, infrastructure is
production-ready for the bridge to launch on top of.

### H-6: register upstream (optional)

```bash
./scripts/submit-registry-pr.sh
```

Drafts a PR adding `chains/etica/` to `hyperlane-xyz/hyperlane-registry`.
This is a discoverability convenience: once merged, anyone can do
`hyperlane core deploy --chain etica` from a fresh CLI install
without our local registry config. The bridge runs fine on the
self-hosted registry; upstream review can take weeks and is not a
blocker.

### H-7: hand off to bridge walkthrough

Drop the deployed Etica mailbox address into:

```ts
// packages/shared/src/addresses.ts
export const HYPERLANE_MAILBOX_ETICA = '0x…'; // from configs/etica-deploy.yaml
```

…then resume `docs/BRIDGE_DEPLOY_WALKTHROUGH.md` from Phase 0.

## Failure modes & runbook

| Symptom | Likely cause | Fix |
|---|---|---|
| `provision-hetzner.sh` returns "Cloud API: forbidden" | Token doesn't have R&W scope | Regenerate at console.hetzner.cloud → Security → API Tokens |
| `setup-r2.sh` returns "10000: Authentication error" | API token lacks R2 Edit | Edit token permissions, add "R2: Edit" |
| `deploy-core.sh` reverts during ProxyAdmin tx | Deployer EOA out of EGAZ | Top up the deployer to ≥10 EGAZ and rerun (script is idempotent) |
| `docker compose ps` shows validator restarting | R2 credentials wrong, or signing key malformed | Re-run `setup-r2.sh`; check `HYP_VALIDATOR_KEY` is `0x` + 64 hex chars |
| `smoke-test.sh` Etica → BNB times out | Relayer EOA out of BNB | Top up relayer EOA with 0.05 BNB and retry |
| `monitor.sh` alerts "validator has not signed in 30 min" | Etica RPC stalled, or container OOM | `docker logs etica-hyperlane-validator`; bounce with `docker compose restart validator` |
| Compose project gone after VPS reboot | `restart: unless-stopped` should auto-start, but Docker daemon may need enabling | `systemctl enable --now docker` on the VPS |

## Multi-validator growth path (post-launch)

Hyperlane's MultisigISM on Eth + BNB supports M-of-N validators. At
launch we run a single validator (us). Growing to 3-of-5 post-launch:

1. Recruit 2–4 more validators (community / partners / chains).
2. Each runs the same `apps/hyperlane-validator/` bundle on their
   own VPS, posts to their own R2 bucket (or any S3-compatible
   storage).
3. Each calls `validatorAnnounce.announce` on the chains they sign
   for, with their public key + bucket URL.
4. Operator calls `requestSetValidatorSet` on each remote chain's
   `MultisigISM` (24h timelock per Hyperlane standard) with the
   expanded validator list and threshold.
5. After timelock, `executeSetValidatorSet`. Inbound messages now
   require M-of-N signatures.

There's no protocol slashing in Hyperlane today — validator
discipline is operator-discretion. The bridge's 48h challenge
window + operator veto are the substantive defense; validator
diversity is hardening, not the primary security layer.

## Migrating signing keys to KMS (post-launch)

Production-grade key custody uses AWS KMS instead of a hex key in
an env file. Swap is one config change:

```diff
# In configs/agent-config.json (or via env vars):
- "signer": { "type": "hexKey", "key": "0x..." }
+ "signer": { "type": "aws", "region": "us-east-1",
+             "id": "alias/hyperlane-etica-validator-signer" }
```

Hyperlane agent supports KMS natively. The daemon authenticates
to AWS via standard SDK env vars / IAM role. Hex key remains in
place at v1 launch because:

1. The 48h challenge window + operator veto contain the blast radius
   of a leaked validator key.
2. KMS adds AWS account dependency to the bridge stack; not worth
   the operational complexity until validator set is multi-party.

## See also

- [`apps/hyperlane-validator/README.md`](../apps/hyperlane-validator/README.md) —
  click-by-click bundle invocation
- [`docs/BRIDGE_DEPLOY_WALKTHROUGH.md`](./BRIDGE_DEPLOY_WALKTHROUGH.md) —
  Phase 0 onwards
- [`docs/BRIDGE_DESIGN.md`](./BRIDGE_DESIGN.md) §3 step 1.5 — original
  acknowledgement that Hyperlane on Etica is a v1-launch prereq
- [Hyperlane: Deploy to a New Chain](https://docs.hyperlane.xyz/docs/deploy-hyperlane)
- [Hyperlane: Run Validators](https://docs.hyperlane.xyz/docs/operate/validators/run-validators)
- [Hyperlane: Run a Relayer](https://docs.hyperlane.xyz/docs/operate/relayer/run-relayer)
