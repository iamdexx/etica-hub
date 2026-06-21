#!/usr/bin/env bash
#
# wRES local two-chain E2E harness — one-command runner.
#
# Usage:   ./e2e/run.sh          (from apps/wres-keeper)
#          bash apps/wres-keeper/e2e/run.sh  (from repo root)
#
# Prerequisites:
#   - Docker (for tronbox/tre java-tron node)
#   - anvil  (from Foundry — `curl -L https://foundry.paradigm.xyz | bash`)
#   - Node >=18, pnpm
#
# What it does:
#   1. Starts a local anvil chain (Etica/EVM, :8545, chain-id 61803)
#   2. Starts a local java-tron node via Docker (TRON, :9090)
#   3. Waits for both to be reachable
#   4. Runs the full E2E harness (deploy → wire → lock → keeper ticks → assert)
#   5. Tears down both chains on exit
#
# Exit code 0 = all assertions passed; 1 = something broke.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEEPER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ANVIL_PORT="${WRES_E2E_ANVIL_PORT:-8545}"
ANVIL_CHAIN_ID="${WRES_E2E_ANVIL_CHAIN_ID:-61803}"
TRON_PORT="${WRES_E2E_TRON_PORT:-9090}"
TRON_CONTAINER="wres-e2e-tron"

ANVIL_PID=""

cleanup() {
  echo ""
  echo "--- Tearing down ---"
  if [ -n "$ANVIL_PID" ] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    echo "  anvil stopped (pid $ANVIL_PID)"
  fi
  if docker ps -q --filter "name=$TRON_CONTAINER" 2>/dev/null | grep -q .; then
    docker rm -f "$TRON_CONTAINER" >/dev/null 2>&1 || true
    echo "  tron container removed"
  fi
  # Clean up generated .env.local
  rm -f "$SCRIPT_DIR/.env.local"
}
trap cleanup EXIT

# ── 1. Start anvil ──────────────────────────────────────────────────────────
echo "Starting anvil on :${ANVIL_PORT} (chain-id ${ANVIL_CHAIN_ID})..."
anvil --host 127.0.0.1 --port "$ANVIL_PORT" --chain-id "$ANVIL_CHAIN_ID" \
  >/dev/null 2>&1 &
ANVIL_PID=$!

# ── 2. Start java-tron ─────────────────────────────────────────────────────
echo "Starting java-tron on :${TRON_PORT} (Docker: ${TRON_CONTAINER})..."
docker rm -f "$TRON_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$TRON_CONTAINER" --platform linux/arm64 \
  -p "${TRON_PORT}:9090" tronbox/tre:latest >/dev/null 2>&1

# ── 3. Wait for both chains ────────────────────────────────────────────────
echo -n "Waiting for anvil..."
for i in $(seq 1 30); do
  if curl -sf -X POST "http://127.0.0.1:${ANVIL_PORT}" \
    -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    >/dev/null 2>&1; then
    echo " ready."
    break
  fi
  sleep 1
  [ "$i" -eq 30 ] && { echo " TIMEOUT"; exit 1; }
done

echo -n "Waiting for java-tron (this can take 2-4 min under qemu)..."
for i in $(seq 1 300); do
  resp=$(curl -sf "http://127.0.0.1:${TRON_PORT}/wallet/getnowblock" 2>/dev/null || true)
  if [ -n "$resp" ] && echo "$resp" | grep -q "blockID"; then
    echo " ready."
    break
  fi
  sleep 1
  [ "$i" -eq 300 ] && { echo " TIMEOUT"; exit 1; }
done

# ── 4. Run the harness ─────────────────────────────────────────────────────
echo ""
echo "=== Running wRES E2E harness ==="
echo ""
cd "$KEEPER_DIR"
exec npx tsx e2e/run-harness.ts
