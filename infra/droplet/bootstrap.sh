#!/bin/bash
# One-shot droplet bootstrap: clone/update the repo under /opt/eticahub and
# bring the explorer stack up. Idempotent; re-run to pull + rebuild.
set -euo pipefail
REPO=${REPO:-https://github.com/iamdexx/etica-hub.git}
REF=${REF:-main}
DIR=/opt/eticahub
command -v docker >/dev/null || { echo "docker missing (cloud-init still running?)"; exit 1; }
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin && git -C "$DIR" checkout -q "$REF" && git -C "$DIR" pull -q --ff-only origin "$REF"; else git clone -q -b "$REF" "$REPO" "$DIR"; fi
cd "$DIR/infra/droplet"
if [ ! -f .env ]; then
  sed "s/^PG_PASSWORD=.*/PG_PASSWORD=$(openssl rand -hex 24)/" .env.example > .env
  chmod 600 .env
fi
mkdir -p data/postgres data/caddy
docker compose up -d --build --remove-orphans
docker compose ps
