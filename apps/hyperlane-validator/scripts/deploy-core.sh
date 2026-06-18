#!/usr/bin/env bash
# Run `hyperlane core deploy` on Etica.
#
# Inputs (from .env):
#   ETICA_HYPERLANE_DEPLOYER_KEY — funded burner key (≥10 EGAZ)
#   BRIDGE_OWNER_ADDRESS         — owner of deployed contracts
#   ETICA_RPC_URL                — Etica RPC URL
#
# Outputs:
#   ~/.hyperlane/chains/etica/addresses.yaml — written by Hyperlane CLI
#   configs/etica-deploy.yaml                — copy committed to repo
#
# Side effects:
#   Updates configs/agent-config.json `etica.addresses` block in-place
#   with the deployed addresses, so validator/relayer can pick them up.

source "$(dirname "$0")/_common.sh"
load_env
require ETICA_HYPERLANE_DEPLOYER_KEY
require BRIDGE_OWNER_ADDRESS

# 1. Verify hyperlane CLI is installed.
if ! command -v hyperlane >/dev/null; then
  log "installing @hyperlane-xyz/cli globally"
  npm install -g @hyperlane-xyz/cli@latest
fi

# 2. Generate relayer key + derive its address (used by trustedRelayerIsm).
if [[ -z "${HYP_RELAYER_KEY:-}" ]]; then
  log "generating fresh relayer signing key"
  HYP_RELAYER_KEY="0x$(openssl rand -hex 32)"
  write_env HYP_RELAYER_KEY "${HYP_RELAYER_KEY}"
fi
relayer_address="$(node -e "
  const { privateKeyToAccount } = require('viem/accounts');
  console.log(privateKeyToAccount('${HYP_RELAYER_KEY}').address);
" 2>/dev/null || true)"
if [[ -z "${relayer_address}" ]]; then
  fail "Could not derive relayer address. Install dependencies: pnpm install"
fi
log "relayer address: ${relayer_address}"

# 3. Generate validator signing key if missing (signing key is NOT
#    funded — it just signs roots).
if [[ -z "${HYP_VALIDATOR_KEY:-}" ]]; then
  log "generating fresh validator signing key"
  HYP_VALIDATOR_KEY="0x$(openssl rand -hex 32)"
  write_env HYP_VALIDATOR_KEY "${HYP_VALIDATOR_KEY}"
fi

# 4. Materialize Etica chain metadata into the local Hyperlane registry.
mkdir -p "${HOME}/.hyperlane/chains/etica"
cp "${BUNDLE_ROOT}/configs/etica-metadata.yaml" "${HOME}/.hyperlane/chains/etica/metadata.yaml"

# 5. Render the core-config from template.
mkdir -p "${BUNDLE_ROOT}/generated"
core_config="${BUNDLE_ROOT}/generated/etica-core-config.yaml"
sed \
  -e "s|\${BRIDGE_OWNER_ADDRESS}|${BRIDGE_OWNER_ADDRESS}|g" \
  -e "s|\${HYP_RELAYER_ADDRESS}|${relayer_address}|g" \
  "${BUNDLE_ROOT}/configs/etica-core-config.yaml" > "${core_config}"
log "rendered core config to ${core_config}"

# 6. Broadcast.
log "broadcasting hyperlane core deploy on Etica (chain 61803). Takes ~5–15 min."
HYP_KEY="${ETICA_HYPERLANE_DEPLOYER_KEY}" hyperlane core deploy \
  --chain etica \
  --config "${core_config}" \
  --yes

# 7. Pull deployed addresses out of the registry.
addresses_file="${HOME}/.hyperlane/chains/etica/addresses.yaml"
if [[ ! -f "${addresses_file}" ]]; then
  fail "deploy claimed success but ${addresses_file} not written. Inspect Hyperlane CLI output above."
fi
cp "${addresses_file}" "${BUNDLE_ROOT}/configs/etica-deploy.yaml"
log "addresses written to ${BUNDLE_ROOT}/configs/etica-deploy.yaml"
log "addresses.yaml contents:"
cat "${addresses_file}" | sed 's/^/    /' >&2

# 8. Patch agent-config.json `etica.addresses` block in-place.
log "patching agent-config.json with deployed addresses"
node "${SCRIPT_DIR}/_patch-agent-config.mjs" "${addresses_file}"

mailbox="$(awk '/^mailbox:/{print $2}' "${addresses_file}" | tr -d '"' )"
log "✓ Hyperlane Etica mailbox deployed at: ${mailbox}"
log "  (this is the value to drop into packages/shared/src/addresses.ts as HYPERLANE_MAILBOX_ETICA)"
log ""
log "Next: ./scripts/install-on-vps.sh"
