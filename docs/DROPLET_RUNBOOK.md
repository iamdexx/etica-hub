# EticaHub droplet runbook

One DigitalOcean droplet (`eticahub-1`, tor1, 2 vCPU / 4 GB, Ubuntu 24.04, Docker, weekly backups)
hosts the self-hosted Etica explorer and, once the USDC bridge is on mainnet, the Hyperlane agents.

Access for Devin sessions is fully scripted — see `.agents/skills/eticahub-droplet-access/SKILL.md`
(three org secrets: `ETICAHUB_DROPLET_IP`, `ETICAHUB_DROPLET_SSH_KEY`, `ETICAHUB_DO_API_TOKEN`).

## Explorer stack (`infra/droplet/`)

| Service | Image | Role |
| --- | --- | --- |
| `db` | `postgres:16-alpine` | indexed chain data, bind-mounted at `data/postgres` |
| `engine` | built from `infra/droplet/engine` | [etica-explorer-engine](https://github.com/etica/etica-explorer-engine) sync scripts + REST API on `:6633` |
| `eticascan` | built from `infra/droplet/Dockerfile.eticascan` | `apps/eticascan` Next.js UI on `:3000` |
| `caddy` | `caddy:2-alpine` | `:80`/`:443`; `/api/*` → engine, everything else → UI |

First boot: `bootstrap.sh` clones the repo to `/opt/eticahub`, generates `.env` (random `PG_PASSWORD`),
runs the knex migrations, and `seed.js` inserts one block `SEED_LOOKBACK_BLOCKS` (5,000) behind head
so the engine walks forward from there instead of crashing on an empty table (upstream behaviour) or
backfilling 10M blocks over a public RPC. Sync speed is roughly one block per second on the public RPC.

Operations (as root on the droplet, `cd /opt/eticahub/infra/droplet`):

- Redeploy after a merge to `main`: `./bootstrap.sh` (git pull + `docker compose up -d --build`).
- Logs: `docker compose logs -f engine` / `eticascan` / `caddy`.
- Custom domain + TLS: point an A record at the droplet, set `SITE_ADDRESS=<hostname>` in `.env`,
  `docker compose up -d caddy`. Caddy obtains and renews the certificate.
- Different RPC: `ETICA_RPC_URL` in `.env`, `docker compose up -d engine`.
- Reset the index: `docker compose down && rm -rf data/postgres && ./bootstrap.sh`.

## Bridge agents (`infra/hyperlane/agents/`)

Brought up after `deploy.sh warp` + `agent-config` have landed on `main`; the procedure, key handling
and health checks are in `docs/HYPERLANE_USDC_RUNBOOK.md`. Both stacks fit in 4 GB with headroom
(explorer ~1 GB, agents ~1.5 GB).
