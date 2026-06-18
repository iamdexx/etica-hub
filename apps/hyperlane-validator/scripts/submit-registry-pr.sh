#!/usr/bin/env bash
# Draft a PR for hyperlane-xyz/hyperlane-registry adding `chains/etica/`.
#
# This is a discoverability step — the bridge runs fine on the
# self-hosted registry while upstream review is pending. Submitting
# upstream means CLI users can do `hyperlane core deploy --chain etica`
# without our local config.
#
# Outputs:
#   /tmp/hyperlane-registry-fork/ — local clone with the new chain dir
#   prints the PR creation URL — operator clicks Submit

source "$(dirname "$0")/_common.sh"
load_env

UPSTREAM="https://github.com/hyperlane-xyz/hyperlane-registry.git"
WORKDIR="/tmp/hyperlane-registry-fork"

if [[ ! -d "${WORKDIR}" ]]; then
  log "cloning hyperlane-registry to ${WORKDIR}"
  git clone --depth=1 "${UPSTREAM}" "${WORKDIR}"
fi
cd "${WORKDIR}"

# Use a fresh branch each run to avoid conflict with upstream changes.
branch="etica-add-chain-$(date +%s)"
git fetch origin main
git checkout -B "${branch}" origin/main

mkdir -p "chains/etica"
cp "${BUNDLE_ROOT}/configs/etica-metadata.yaml" "chains/etica/metadata.yaml"
if [[ -f "${BUNDLE_ROOT}/configs/etica-deploy.yaml" ]]; then
  cp "${BUNDLE_ROOT}/configs/etica-deploy.yaml" "chains/etica/addresses.yaml"
else
  warn "configs/etica-deploy.yaml missing — addresses.yaml NOT staged. Run scripts/deploy-core.sh first."
fi

# Logo. The repo wants logos as SVG with a flat naming convention.
if [[ -f "${BUNDLE_ROOT}/configs/etica-logo.svg" ]]; then
  cp "${BUNDLE_ROOT}/configs/etica-logo.svg" "chains/etica/logo.svg"
else
  warn "configs/etica-logo.svg missing. Add an SVG before submitting."
fi

git add "chains/etica"
git commit -m "feat(chains): add etica (chain id 61803)

Etica is a permissionless EVM-compatible PoW chain. Native gas is
EGAZ; protocol token is ETI (mineable on the same chain).

This adds chain metadata, addresses for the freshly deployed
Mailbox + ProxyAdmin + ValidatorAnnounce + IGP + InterchainSecurityModule,
and logo for explorer/UI surfaces.

The validator + relayer for this chain are operated by the EticaHub
team and post checkpoint signatures to a public Cloudflare R2 bucket
(see chains/etica/metadata.yaml -> blockExplorers for the validator
announce URL once announced)."

log "PR branch ready locally at ${WORKDIR} (branch: ${branch})"
log ""
log "To open the PR:"
log "  1. fork hyperlane-xyz/hyperlane-registry on github.com (one-click)"
log "  2. cd ${WORKDIR}"
log "  3. git remote add fork https://github.com/<your-gh>/hyperlane-registry.git"
log "  4. git push fork ${branch}"
log "  5. open https://github.com/hyperlane-xyz/hyperlane-registry/compare/main...<your-gh>:${branch}"
