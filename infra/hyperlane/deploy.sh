#!/usr/bin/env bash
# Deploy Hyperlane core on Etica and the USDC (Ethereum) <-> USDC.e (Etica) warp route.
#
# Usage:
#   OWNER=0x... VALIDATOR=0x... HYP_KEY=0x... ./infra/hyperlane/deploy.sh [core|warp|agent-config|all]
#
#   OWNER      address that owns the mailbox/ISM/routers (a Safe, ideally; may
#              equal the deployer at first and be transferred later)
#   VALIDATOR  address of the validator key run by infra/hyperlane/agents
#   HYP_KEY    deployer private key, funded with EGAZ on Etica and ETH on
#              Ethereum (warp step only). Never written to disk by this script.
#   REGISTRY   optional; defaults to ./infra/hyperlane/registry
#
# Requires Node >= 22 and `npx @hyperlane-xyz/cli`. Rendered configs go to
# $REGISTRY/deployments/... and are meant to be committed (they contain the
# deployed addresses — no secrets).
#
# Tested end-to-end against anvil forks of both chains (core deploy, warp
# deploy, USDC -> USDC.e mint, USDC.e -> USDC redemption via the docker-compose
# agents). Ethereum's canonical mailbox is used in production; the local
# registry only overrides Etica.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="${REGISTRY:-$HERE/registry}"
STEP="${1:-all}"
ZERO=0x0000000000000000000000000000000000000000
CLI=(npx --yes @hyperlane-xyz/cli@44.0.2)

need() { [[ -n "${!1:-}" ]] || { echo "missing env $1" >&2; exit 1; }; }
addr() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "$2 is not an address: $1" >&2; exit 1; }; }

need OWNER; need VALIDATOR; addr "$OWNER" OWNER; addr "$VALIDATOR" VALIDATOR
[[ "$OWNER" != "$ZERO" && "$VALIDATOR" != "$ZERO" ]] || { echo "OWNER/VALIDATOR must not be zero" >&2; exit 1; }
if [[ "$STEP" != "agent-config" ]]; then need HYP_KEY; fi

render() {
  # $1 = template, $2 = out. Placeholders: every zero address is OWNER except
  # entries under `validators:` which are VALIDATOR.
  awk -v owner="$OWNER" -v validator="$VALIDATOR" -v zero="$ZERO" '
    /^[[:space:]]*validators:/ { inval=1; print; next }
    inval && /^[[:space:]]*-[[:space:]]*"?0x/ { gsub(zero, validator); print; next }
    { inval=0; gsub(zero, owner); print }
  ' "$1" > "$2"
  if grep -q "$ZERO" "$2"; then echo "unfilled placeholder in $2" >&2; exit 1; fi
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

deploy_core() {
  render "$HERE/configs/core-config.yaml" "$TMP/core.yaml"
  echo ">> hyperlane core deploy --chain etica"
  "${CLI[@]}" core deploy --chain etica --config "$TMP/core.yaml" --registry "$REGISTRY" --yes
  echo ">> core addresses written to $REGISTRY/chains/etica/addresses.yaml"
}

deploy_warp() {
  [[ -f "$REGISTRY/chains/etica/addresses.yaml" ]] || { echo "deploy core first" >&2; exit 1; }
  mkdir -p "$REGISTRY/deployments/warp_routes/USDC"
  render "$HERE/configs/warp-usdc.yaml" "$REGISTRY/deployments/warp_routes/USDC/etica-deploy.yaml"
  echo ">> hyperlane warp deploy --warp-route-id USDC/etica"
  "${CLI[@]}" warp deploy --warp-route-id USDC/etica --registry "$REGISTRY" --yes
  echo ">> route written to $REGISTRY/deployments/warp_routes/USDC/etica-config.yaml"
}

agent_config() {
  # Etica has no IGP at launch; the CLI asks to zero it, hence the piped "y".
  printf 'y\ny\n' | "${CLI[@]}" registry agent-config --chains etica ethereum \
    --registry "$REGISTRY" -o "$HERE/agents/agent-config.json" --yes
  echo ">> $HERE/agents/agent-config.json"
}

case "$STEP" in
  core) deploy_core ;;
  warp) deploy_warp ;;
  agent-config) agent_config ;;
  all) deploy_core; deploy_warp; agent_config ;;
  *) echo "unknown step $STEP" >&2; exit 1 ;;
esac
