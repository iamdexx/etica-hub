#!/usr/bin/env bash
# Deploys the EticaHub non-custodial trading stack on Etica mainnet:
#   1. DutchOrderReactor           (verbatim from UniswapX, audited upstream)
#   2. OrderQuoter                 (verbatim from UniswapX)
#   3. EticaProtocolFeeController  (our ETX-denominated fee controller)
# Then wires the fee controller onto the reactor.
#
# Permit2 must be deployed FIRST (see packages/contracts/script/deploy-permit2.sh).
#
# Required env:
#   ETICA_MAINNET_RPC_URL
#   DEPLOYER_PK
#   PERMIT2_ADDRESS
#   ETX_ADDRESS
#   TREASURY_ADDRESS
#   REACTOR_OWNER
# Optional env:
#   INITIAL_FEE_BPS   (default: 0 — keeps fee-off at launch)

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TC_DIR=$(cd "$HERE/.." && pwd)

: "${ETICA_MAINNET_RPC_URL:?ETICA_MAINNET_RPC_URL must be set}"
: "${DEPLOYER_PK:?DEPLOYER_PK must be set (private key of deployer wallet)}"
: "${PERMIT2_ADDRESS:?PERMIT2_ADDRESS must be set — deploy Permit2 first}"
: "${ETX_ADDRESS:?ETX_ADDRESS must be set (0xa5a1bc6307b0b87989b8456d4b35f88a68650044 on Etica mainnet)}"
: "${TREASURY_ADDRESS:?TREASURY_ADDRESS must be set}"
: "${REACTOR_OWNER:?REACTOR_OWNER must be set (owner of reactor + fee controller)}"

cd "$TC_DIR"

git submodule update --init --recursive lib/uniswapx

forge script script/DeployTradingStack.s.sol:DeployTradingStack \
  --rpc-url "$ETICA_MAINNET_RPC_URL" \
  --private-key "$DEPLOYER_PK" \
  --broadcast \
  -vvv
