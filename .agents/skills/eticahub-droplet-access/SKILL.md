---
name: eticahub-droplet-access
description: SSH into the EticaHub DigitalOcean droplet (explorer + Hyperlane bridge agents) and manage it via the DigitalOcean API. Use whenever a task touches the droplet, the self-hosted explorer, the bridge validator/relayer, or DigitalOcean.
---

# EticaHub droplet access

Everything needed lives in three **org-level Devin secrets** (set 2026-10-07). Never ask the
user for SSH access, a root password, or a DigitalOcean token — use these:

| Secret | What it is |
| --- | --- |
| `ETICAHUB_DROPLET_IP` | public IPv4 of droplet `eticahub-1` (tor1, 2 vCPU / 4 GB, Ubuntu 24.04 + Docker) |
| `ETICAHUB_DROPLET_SSH_KEY` | ed25519 private key authorised for `root@` on that droplet |
| `ETICAHUB_DO_API_TOKEN` | DigitalOcean PAT `devin-eticahub` (full access, no expiry) |

## Connect

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
printf '%s\n' "$ETICAHUB_DROPLET_SSH_KEY" > ~/.ssh/eticahub_droplet && chmod 600 ~/.ssh/eticahub_droplet
cat >> ~/.ssh/config <<CFG
Host eticahub-droplet
  HostName $ETICAHUB_DROPLET_IP
  User root
  IdentityFile ~/.ssh/eticahub_droplet
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
CFG
ssh eticahub-droplet 'hostname; docker compose -f /opt/eticahub/infra/droplet/docker-compose.yml ps'
```

If `ssh` is refused, check the droplet state first (the account was once suspended for
non-payment, which powers droplets off):

```bash
curl -s -H "Authorization: Bearer $ETICAHUB_DO_API_TOKEN" https://api.digitalocean.com/v2/droplets \
  | python3 -c "import sys,json;[print(d['id'],d['name'],d['status'],[n['ip_address'] for n in d['networks']['v4'] if n['type']=='public']) for d in json.load(sys.stdin)['droplets']]"
# power on: curl -X POST -H "Authorization: Bearer $ETICAHUB_DO_API_TOKEN" -H 'Content-Type: application/json' \
#   -d '{"type":"power_on"}' https://api.digitalocean.com/v2/droplets/<id>/actions
```

If the IP ever changes (droplet rebuilt), update `ETICAHUB_DROPLET_IP` with `suggest_save_secret`
and re-run `infra/droplet/bootstrap.sh` on the new box — never create a per-session SSH key again.

## What runs where

- `/opt/eticahub` — clone of this repo (branch `main`).
- `/opt/eticahub/infra/droplet` — explorer stack (`docker compose`): Postgres, `etica-explorer-engine`
  (sync + `/api` on :6633), `apps/eticascan` UI (:3000), Caddy on :80/:443. `.env` holds `PG_PASSWORD`.
  Redeploy after a merge: `ssh eticahub-droplet /opt/eticahub/infra/droplet/bootstrap.sh`.
- `/opt/eticahub/infra/hyperlane/agents` — Hyperlane validator/relayer (`docker compose`), only after
  the mainnet bridge contracts exist (`docs/HYPERLANE_USDC_RUNBOOK.md`). The validator key is generated
  on the droplet and lives only in that directory's `.env` — never copy it off the box.
- Weekly DigitalOcean backups (Sunday 04:00 UTC) are enabled on the droplet.
