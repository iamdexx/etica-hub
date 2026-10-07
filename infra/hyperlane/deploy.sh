#!/usr/bin/env bash
# Deploy Hyperlane core on Etica and the USDC (Ethereum) <-> USDC.e (Etica) warp route.
#
# Usage:
#   OWNER=0x... VALIDATOR=0x... KEEPER=0x... GUARDIAN=0x... HYP_KEY=0x... ./infra/hyperlane/deploy.sh [core|warp|agent-config|all]
#
#   OWNER      address that owns the mailbox/ISM/routers/rate limit (a Safe,
#              ideally; may equal the deployer at first and be transferred later)
#   VALIDATOR  address of the validator key run by infra/hyperlane/agents
#   KEEPER     address of the relayer / gas-paying EOA (RELAYER_KEY in
#              agents/.env). Owns the per-router fee contracts so it can sweep
#              the USDC fees that pay for its own gas (warp step only).
#   GUARDIAN   owner of the PausableIsm on each router: can halt inbound
#              delivery and nothing else. May be a hot key held by the
#              healthcheck host so an invariant breach pauses the route
#              automatically (warp step only).
#   HYP_KEY    deployer private key, funded with EGAZ on Etica and ETH on
#              Ethereum (warp step only). Never written to disk by this script.
#   REGISTRY   optional; defaults to ./infra/hyperlane/registry
#   ETHEREUM_RPC / ETICA_RPC  optional comma-separated RPC URLs (agent-config
#              step reads the head block from them; defaults to public endpoints)
#
# The Etica router's fee contract is NOT the CLI's LinearFee: the warp step
# deploys packages/contracts/src/bridge/WarpFlatLinearFee.sol (flat 2 USDC.e +
# 50 bps capped at 50) with `forge create` and points the router at it, so
# dust redemptions can never drain the relayer's Ethereum gas.
#
# Requires Node >= 22 (npm) and foundry (`forge`, `cast`); the Hyperlane CLI
# is installed and rebuilt for Paris by paris-cli.sh on first run.
# Rendered configs go to $REGISTRY/deployments/... and are meant to be
# committed (they contain the deployed addresses — no secrets).
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
KEEPER_PLACEHOLDER=0x1111111111111111111111111111111111111111
GUARDIAN_PLACEHOLDER=0x2222222222222222222222222222222222222222
# Etica (CoreGeth) has no Cancun opcodes and the stock CLI embeds Cancun
# bytecode (`invalid opcode: MCOPY` on the first mainnet attempt), so deploy
# with a CLI whose contracts are rebuilt for Paris. See paris-cli.sh.
CLI=(node "$("$HERE/paris-cli.sh")")
CONTRACTS="$(cd "$HERE/../../packages/contracts" && pwd)"
ETICA_RPC="${ETICA_RPC:-https://eticamainnet.eticaprotocol.org}"
ETHEREUM_RPC="${ETHEREUM_RPC:-https://gateway.tenderly.co/public/mainnet,https://rpc.mevblocker.io,https://eth.drpc.org,https://ethereum-rpc.publicnode.com}"
# Etica fee: flat 2 USDC.e + 50 bps capped at 50 USDC.e (6 decimals).
ETICA_FEE_FLAT=2000000; ETICA_FEE_MAX_LINEAR=50000000; ETICA_FEE_HALF_AMOUNT=5000000000

need() { [[ -n "${!1:-}" ]] || { echo "missing env $1" >&2; exit 1; }; }
addr() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "$2 is not an address: $1" >&2; exit 1; }; }

need OWNER; need VALIDATOR; addr "$OWNER" OWNER; addr "$VALIDATOR" VALIDATOR
[[ "$OWNER" != "$ZERO" && "$VALIDATOR" != "$ZERO" ]] || { echo "OWNER/VALIDATOR must not be zero" >&2; exit 1; }
if [[ "$STEP" == "warp" || "$STEP" == "all" ]]; then
  need KEEPER; addr "$KEEPER" KEEPER
  [[ "$KEEPER" != "$ZERO" && "$KEEPER" != "$KEEPER_PLACEHOLDER" ]] || { echo "KEEPER must be a real address" >&2; exit 1; }
  need GUARDIAN; addr "$GUARDIAN" GUARDIAN
  [[ "$GUARDIAN" != "$ZERO" && "$GUARDIAN" != "$GUARDIAN_PLACEHOLDER" ]] || { echo "GUARDIAN must be a real address" >&2; exit 1; }
  [[ "$KEEPER" != "$OWNER" && "$VALIDATOR" != "$OWNER" && "$VALIDATOR" != "$KEEPER" ]] || { echo "OWNER, VALIDATOR and KEEPER must be distinct keys" >&2; exit 1; }
  command -v forge >/dev/null && command -v cast >/dev/null || { echo "foundry (forge, cast) required for the Etica fee contract" >&2; exit 1; }
fi
if [[ "$STEP" != "agent-config" ]]; then need HYP_KEY; fi

render() {
  # $1 = template, $2 = out. Placeholders: every zero address is OWNER except
  # entries under `validators:` which are VALIDATOR; 0x111…1 is KEEPER;
  # 0x222…2 is GUARDIAN.
  awk -v owner="$OWNER" -v validator="$VALIDATOR" -v keeper="${KEEPER:-$KEEPER_PLACEHOLDER}" \
      -v guardian="${GUARDIAN:-$GUARDIAN_PLACEHOLDER}" \
      -v zero="$ZERO" -v kp="$KEEPER_PLACEHOLDER" -v gp="$GUARDIAN_PLACEHOLDER" '
    { gsub(kp, keeper); gsub(gp, guardian) }
    /^[[:space:]]*validators:/ { inval=1; print; next }
    inval && /^[[:space:]]*-[[:space:]]*["\x27]?0x/ { gsub(zero, validator); print; next }
    { inval=0; gsub(zero, owner); print }
  ' "$1" > "$2"
  for ph in "$ZERO" "$KEEPER_PLACEHOLDER" "$GUARDIAN_PLACEHOLDER"; do
    if grep -q "$ph" "$2"; then echo "unfilled placeholder $ph in $2" >&2; exit 1; fi
  done
}

route_address() {  # $1 = chain name -> router address from the deployed route config
  python3 -c "import sys,yaml;t=yaml.safe_load(open(sys.argv[1]))['tokens'];print([x['addressOrDenom'] for x in t if x['chainName']==sys.argv[2]][0])" \
    "$REGISTRY/deployments/warp_routes/USDC/etica-config.yaml" "$1"
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
  deploy_etica_fee
}

deploy_etica_fee() {
  local router fee
  router="$(route_address etica)"
  echo ">> forge create WarpFlatLinearFee (token=$router [synthetic HypERC20 router == USDC.e token] flat=$ETICA_FEE_FLAT max=$ETICA_FEE_MAX_LINEAR half=$ETICA_FEE_HALF_AMOUNT owner=$KEEPER)"
  fee="$(cd "$CONTRACTS" && forge create src/bridge/WarpFlatLinearFee.sol:WarpFlatLinearFee \
    --rpc-url "$ETICA_RPC" --private-key "$HYP_KEY" --broadcast --legacy \
    --constructor-args "$router" "$ETICA_FEE_FLAT" "$ETICA_FEE_MAX_LINEAR" "$ETICA_FEE_HALF_AMOUNT" "$KEEPER" \
    | awk '/Deployed to:/{print $3}')"
  [[ "$fee" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "fee contract deploy failed" >&2; exit 1; }
  # The deployer is still the router owner at this point (ownership moves to
  # OWNER as the last step of `warp deploy` only when OWNER == deployer is false
  # — in that case this call needs the owner, so we try and tell the operator).
  if cast send "$router" 'setFeeRecipient(address)' "$fee" --rpc-url "$ETICA_RPC" --private-key "$HYP_KEY" --legacy >/dev/null 2>&1; then
    echo ">> etica router feeRecipient = $fee"
  else
    echo "!! could not set feeRecipient from the deployer; run as OWNER:" >&2
    echo "   cast send $router 'setFeeRecipient(address)' $fee --rpc-url $ETICA_RPC" >&2
  fi
  echo "$fee" > "$REGISTRY/deployments/warp_routes/USDC/etica-fee-contract.txt"
  echo ">> fee contract recorded in $REGISTRY/deployments/warp_routes/USDC/etica-fee-contract.txt"
}

block_number() {  # $1 = comma-separated RPC URLs -> latest block (decimal), first endpoint that answers
  local url
  for url in ${1//,/ }; do
    curl -sS -m 15 -X POST "$url" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' 2>/dev/null |
      python3 -c 'import sys,json; print(int(json.load(sys.stdin)["result"],16))' 2>/dev/null && return 0
  done
  echo "no RPC in '$1' answered eth_blockNumber" >&2; return 1
}

agent_config() {
  # Etica has no IGP at launch; the CLI asks to zero it, hence the piped "y".
  printf 'y\ny\n' | "${CLI[@]}" registry agent-config --chains etica ethereum \
    --registry "$REGISTRY" -o "$HERE/agents/agent-config.json" --yes
  # The CLI emits `index.from` = each mailbox's deploy block. Ethereum's is
  # millions of blocks back: over keyless public RPCs (100-block log chunks)
  # the agents would backfill for weeks before seeing a live message. Nothing
  # older than the warp route matters to us, so start both chains a little
  # before the current head.
  local eth_from eti_from
  eth_from=$(( $(block_number "$ETHEREUM_RPC") - 300 ))
  eti_from=$(( $(block_number "$ETICA_RPC") - 300 ))
  python3 - "$HERE/agents/agent-config.json" "$eth_from" "$eti_from" <<'PY'
import json, sys
path, eth_from, eti_from = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
cfg = json.load(open(path))
for chain, start in (("ethereum", eth_from), ("etica", eti_from)):
    index = cfg["chains"][chain].setdefault("index", {})
    index["from"] = max(start, 0)
    index["chunk"] = 100
    print(f"   {chain}: index.from={index['from']}")
json.dump(cfg, open(path, "w"), indent=2)
PY
  echo ">> $HERE/agents/agent-config.json"
}

case "$STEP" in
  core) deploy_core ;;
  warp) deploy_warp ;;
  agent-config) agent_config ;;
  all) deploy_core; deploy_warp; agent_config ;;
  *) echo "unknown step $STEP" >&2; exit 1 ;;
esac
