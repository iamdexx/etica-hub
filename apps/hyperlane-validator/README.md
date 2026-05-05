# @etica-hub/hyperlane-validator

Infrastructure-as-code bundle for deploying Hyperlane on Etica
(domain `61803`) and running a validator + relayer.

This is a **prerequisite** for the Phase 3 ETX bridge —
`docs/BRIDGE_DEPLOY_WALKTHROUGH.md` Phase −1 demands
`HYPERLANE_MAILBOX_ETICA` to be set, and Etica isn't in the canonical
`hyperlane-xyz/hyperlane-registry` today, so we deploy it ourselves.

## Cost

| Item | Cost |
|---|---|
| One-time deploy gas (Etica) | ~5–10 EGAZ (≈ free) |
| VPS (Hetzner CX22) | ~€4.50/mo (~$5/mo) |
| Object storage (Cloudflare R2) | $0/mo (free tier covers years) |
| **Total recurring** | **~$5/mo** |

Funded entirely from the bridge's 0.1% fee revenue per spec
§1.3 (80% routes to harvester / treasury).

## Architecture

```
┌─────────────────────┐       ┌─────────────────────┐
│  Etica  Mailbox     │──┐    │  Eth   Mailbox      │
│  (we deploy)        │  │    │  (canonical)        │
│  domain 61803       │  │    │  domain 1           │
└─────────────────────┘  │    └─────────────────────┘
         ▲               │             ▲
         │ signs roots   │             │ delivers msgs
         │               │             │
┌─────────────────────┐  │    ┌─────────────────────┐
│  Etica Validator    │  │    │  Multi-chain Relayer│
│  (this bundle)      │──┴───▶│  (this bundle)      │
└─────────────────────┘ R2    └─────────────────────┘
                  ▲    bucket           │
                  │                     │
                  └─── checkpoint ──────┘
                       signatures

                                ▲
                                │ delivers msgs
                                │
                       ┌─────────────────────┐
                       │  BNB Mailbox        │
                       │  (canonical)        │
                       │  domain 56          │
                       └─────────────────────┘
```

- **Etica Validator daemon** signs Etica `Mailbox` merkle roots and
  posts signatures to a public Cloudflare R2 bucket. One process,
  origin = Etica.
- **Multi-chain Relayer daemon** reads signed checkpoints from R2 and
  delivers inbound messages to `Mailbox` on every destination chain.
  One process, multiple destinations (Etica + Eth + BNB).

Both daemons run in the same Docker Compose project on a single VPS.

## Sequence (end-to-end)

This is the runbook. Each step is automated by a script in `scripts/`.

```
1. provision-hetzner.sh          → spins up CX22 VPS (Hetzner API)
2. setup-r2.sh                   → creates bucket (Cloudflare R2 API)
3. deploy-core.sh                → hyperlane core deploy on Etica
4. install-on-vps.sh             → installs Docker + brings up daemons
5. smoke-test.sh                 → hyperlane send message --relay
6. submit-registry-pr.sh         → drafts upstream registry PR contents
```

After step 5 passes, `~/.hyperlane/chains/etica/addresses.yaml`
contains the Etica `Mailbox` address. Drop it into
`packages/shared/src/addresses.ts` and resume bridge deploy
walkthrough Phase 0.

## Prerequisites

| What | Where it goes |
|---|---|
| Hetzner Cloud API token (Read & Write) | env `HETZNER_API_TOKEN` |
| Cloudflare R2 API token (Object Read & Write) | env `CLOUDFLARE_API_TOKEN` |
| Cloudflare account ID | env `CLOUDFLARE_ACCOUNT_ID` |
| Burner deployer hex key with ≥10 EGAZ on Etica | env `ETICA_HYPERLANE_DEPLOYER_KEY` |
| Owner address (hardware wallet / multisig) | env `BRIDGE_OWNER_ADDRESS` |

All tokens are short-lived infra credentials. The deployer key is
single-use — once `core deploy` succeeds, the deployed contracts'
ownership is transferred to `BRIDGE_OWNER_ADDRESS` and the deployer
key is retired.

Copy `.env.example` to `.env` and fill in:

```bash
cd apps/hyperlane-validator
cp .env.example .env
$EDITOR .env
```

The bundle does **not** commit `.env` — only `.env.example`.

## Step-by-step

### 1. Provision the VPS

```bash
./scripts/provision-hetzner.sh
```

Creates a CX22 VPS in eu-central, Ubuntu 24.04, with an SSH key
auto-generated and stored at `~/.ssh/etica-hyperlane-validator`.
Writes the VPS IP + hostname back to `.env`.

### 2. Create the R2 bucket

```bash
./scripts/setup-r2.sh
```

Creates `etica-hyperlane-validator-signatures` in your Cloudflare
account, makes the bucket publicly readable (validator signatures
are public by design), generates an S3-compatible access key pair,
and writes them back to `.env`.

### 3. Deploy Hyperlane core contracts on Etica

```bash
./scripts/deploy-core.sh
```

Runs `hyperlane core deploy` against Etica with all flags pre-filled.
Takes 5–15 min, broadcasts ~10 contracts. Writes addresses to
`~/.hyperlane/chains/etica/addresses.yaml` and copies them into
`configs/etica-deploy.yaml` for source-control.

The deploy reads `ETICA_HYPERLANE_DEPLOYER_KEY` for signing and
`BRIDGE_OWNER_ADDRESS` for the contract owner field.

### 4. Install on the VPS + start daemons

```bash
./scripts/install-on-vps.sh
```

SSHes into the VPS, installs Docker, copies the Compose bundle +
agent config, and brings up validator + relayer with
`docker compose up -d`. Checks logs for ~60s to confirm both
daemons are healthy.

### 5. Smoke test

```bash
./scripts/smoke-test.sh
```

Sends a test message: `etica → ethereum`, then `etica → bsc`. Waits
for relayer delivery (~30s–2min). Both should succeed.

### 6. Submit upstream registry PR

```bash
./scripts/submit-registry-pr.sh
```

Drafts the contents of an `add chains/etica/` PR against
`hyperlane-xyz/hyperlane-registry` and pushes to a fork of yours.
Prints the PR URL for you to click "submit". This is a
**discoverability** step, not a functional one — the bridge runs
fine on a self-hosted registry while upstream review is pending.

## Monitoring

Two layers:

1. **Docker `restart: unless-stopped`** — daemons auto-restart on crash.
2. **Telegram alerts** — reuses `BRIDGE_TELEGRAM_BOT_TOKEN` /
   `BRIDGE_TELEGRAM_CHAT_ID` from the bridge-watcher. The
   `monitor.sh` script (cron'd on the VPS every 15 min) checks
   that the validator emitted a `checkpoint signed` log line in the
   last 15 min and pings Telegram if it didn't.

## Key custody at launch

| Key | Custody | Rotation if compromised |
|---|---|---|
| Validator signing key | Hex in `.env` on VPS | Hyperlane has no validator slashing today; rotation is `requestSetValidator` on each remote's MultisigISM (24h timelock). |
| Relayer signing key | Hex in `.env` on VPS | Funded with small amounts of ETH/BNB/EGAZ. Rotation = generate new EOA, fund it, swap env, restart. |
| Hyperlane deploy key | Burner, retired post-deploy | N/A — single use |
| Bridge owner key | Hardware wallet (off-VPS) | Multisig 2-of-3 recommended |

A compromised validator key + 48h challenge window: attacker can
sign fake roots to push fake messages to Eth/BNB; operator vetoes
those claims via hardware wallet; net loss is limited to the bond
the attacker had to post (25% of the claim amount). The bridge's
defense-in-depth is the constraint, not validator-key custody.

## Migrating to AWS KMS

The bundle defaults to hex keys for fastest time-to-launch. Swap to
KMS later by changing `validator.env`:

```diff
- HYP_VALIDATOR_KEY=0x...
- HYP_VALIDATOR_TYPE=hexKey
+ HYP_VALIDATOR_TYPE=aws
+ HYP_VALIDATOR_REGION=us-east-1
+ HYP_VALIDATOR_ID=alias/hyperlane-etica-validator-signer
```

…and provisioning the matching KMS key. No code change required.

## Multi-validator growth path

Today, this bundle deploys a single validator (you). Hyperlane's
MultisigISM supports M-of-N straightforwardly; growing to 3-of-5
post-launch:

1. Recruit 2-4 more validators (community / partners).
2. Each runs the same `apps/hyperlane-validator/` bundle on their own
   VPS, posts signatures to their own R2 bucket.
3. Each calls `validatorAnnounce.announce` with their public key +
   bucket URL.
4. Operator calls `requestSetValidatorSet` on each remote's
   `MultisigISM` (24h timelock) with the expanded validator list +
   threshold.
5. Each validator's bond is operator-discretion — Hyperlane has no
   protocol slashing today.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Validator + relayer daemons |
| `.env.example` | Config template |
| `configs/etica-metadata.yaml` | Etica chain metadata for agent + registry PR |
| `configs/etica-core-config.yaml` | `hyperlane core deploy` input (pre-filled) |
| `configs/agent-config.json` | Multi-chain agent config (Etica + Eth + BNB) |
| `scripts/provision-hetzner.sh` | Spin up VPS via API |
| `scripts/setup-r2.sh` | Create R2 bucket via API |
| `scripts/deploy-core.sh` | `hyperlane core deploy` wrapper |
| `scripts/install-on-vps.sh` | Bring daemons up on VPS |
| `scripts/smoke-test.sh` | Round-trip message test |
| `scripts/submit-registry-pr.sh` | Draft upstream registry PR contents |
| `scripts/monitor.sh` | 15-min cron health check |

## See also

- [`docs/HYPERLANE_ON_ETICA.md`](../../docs/HYPERLANE_ON_ETICA.md) —
  prose runbook explaining the *why* behind each step
- [`docs/BRIDGE_DEPLOY_WALKTHROUGH.md`](../../docs/BRIDGE_DEPLOY_WALKTHROUGH.md)
  — Phase 0 onwards, resumes after this bundle completes
- [Hyperlane: Deploy to a New Chain](https://docs.hyperlane.xyz/docs/deploy-hyperlane)
- [Hyperlane: Run Validators](https://docs.hyperlane.xyz/docs/operate/validators/run-validators)
- [Hyperlane: Run a Relayer](https://docs.hyperlane.xyz/docs/operate/relayer/run-relayer)
