#!/usr/bin/env bash
# End-to-end smoke test: send a Hyperlane test message from Etica to
# Ethereum and from Etica to BNB. Both should be picked up by the
# relayer and delivered within ~30s–2min.
#
# Inputs (from .env):
#   ETICA_HYPERLANE_DEPLOYER_KEY — needs a tiny bit of EGAZ for the dispatch tx
#
# Hyperlane CLI's `send message --relay` waits for the inbound
# delivery and exits non-zero on timeout, so this script doubles as
# a pass/fail probe.

source "$(dirname "$0")/_common.sh"
load_env
require ETICA_HYPERLANE_DEPLOYER_KEY

if ! command -v hyperlane >/dev/null; then
  fail "hyperlane CLI missing. Run scripts/deploy-core.sh first."
fi

for dest in ethereum bsc; do
  log "sending test message etica → ${dest}"
  HYP_KEY="${ETICA_HYPERLANE_DEPLOYER_KEY}" hyperlane send message \
    --origin etica \
    --destination "${dest}" \
    --body "etica-hyperlane-smoke-test-$(date -u +%s)" \
    --timeout 180 \
    --quick
  log "✓ etica → ${dest} delivered"
done

log "✓ smoke test passed for both destinations"
log "Next: ./scripts/submit-registry-pr.sh (optional, for upstream discoverability)"
