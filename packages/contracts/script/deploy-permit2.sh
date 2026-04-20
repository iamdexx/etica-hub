#!/usr/bin/env bash
# Deploys the unmodified Permit2 contract (Uniswap Labs, audited by OpenZeppelin,
# ABDK, and Trail of Bits) from `lib/permit2`.
#
# Permit2 pins solc to =0.8.17 and requires via_ir=true, neither of which match
# our own contracts (solc 0.8.26, via_ir=false). To keep our main build simple
# we run permit2's own foundry.toml from inside `lib/permit2`, so its bytecode
# matches the upstream-audited bytecode exactly.
#
# Env:
#   ETICA_MAINNET_RPC_URL   required
#   DEPLOYER_PK             required; private key of the wallet paying gas
#
# Usage:
#   ./script/deploy-permit2.sh
#
# Output: deployment address + broadcast logs under lib/permit2/broadcast/.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CONTRACTS_DIR=$(cd "$HERE/.." && pwd)
PERMIT2_DIR="$CONTRACTS_DIR/lib/permit2"

if [[ ! -d "$PERMIT2_DIR/src" ]]; then
  echo "lib/permit2 submodule is empty. Run: git submodule update --init --recursive" >&2
  exit 1
fi

: "${ETICA_MAINNET_RPC_URL:?ETICA_MAINNET_RPC_URL must be set}"
: "${DEPLOYER_PK:?DEPLOYER_PK must be set (private key of deployer wallet)}"

cd "$PERMIT2_DIR"

# Permit2's own foundry.toml pins solc 0.8.17 + via_ir. It ships its own
# submodules (forge-std, solmate, openzeppelin-contracts, forge-gas-snapshot).
git submodule update --init --recursive .

forge script script/DeployPermit2.s.sol:DeployPermit2 \
  --rpc-url "$ETICA_MAINNET_RPC_URL" \
  --private-key "$DEPLOYER_PK" \
  --broadcast \
  -vvv
