#!/usr/bin/env bash
# Install Docker on the VPS, copy the Compose bundle + agent config,
# and bring the validator + relayer daemons up.
#
# Inputs (from .env):
#   VPS_IP, VPS_SSH_KEY_PATH — set by provision-hetzner.sh
#   plus all R2 + key + RPC vars (passed through to the daemon env file)
#
# Idempotent: re-running redeploys the latest config without
# disturbing daemon state (Compose volumes persist).

source "$(dirname "$0")/_common.sh"
load_env
require VPS_IP
require VPS_SSH_KEY_PATH
require R2_ACCESS_KEY_ID
require R2_SECRET_ACCESS_KEY
require R2_BUCKET_NAME
require R2_ENDPOINT_URL
require HYP_VALIDATOR_KEY
require HYP_RELAYER_KEY
require BRIDGE_OWNER_ADDRESS

REMOTE_DIR="/opt/etica-hyperlane"
SSH=(ssh -i "${VPS_SSH_KEY_PATH}" -o StrictHostKeyChecking=accept-new "root@${VPS_IP}")
SCP=(scp -i "${VPS_SSH_KEY_PATH}" -o StrictHostKeyChecking=accept-new)

# Default validator-tx key to deployer key (still funded, briefly used).
HYP_VALIDATOR_TX_KEY="${HYP_VALIDATOR_TX_KEY:-${ETICA_HYPERLANE_DEPLOYER_KEY:-${HYP_RELAYER_KEY}}}"

# 1. Install Docker if missing.
log "installing Docker on ${VPS_IP} (idempotent)"
"${SSH[@]}" 'command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sh)'

# 2. Make remote dir + copy bundle (Compose + agent config).
"${SSH[@]}" "mkdir -p ${REMOTE_DIR}/configs"
"${SCP[@]}" "${BUNDLE_ROOT}/docker-compose.yml" "root@${VPS_IP}:${REMOTE_DIR}/docker-compose.yml"
"${SCP[@]}" "${BUNDLE_ROOT}/configs/agent-config.json" "root@${VPS_IP}:${REMOTE_DIR}/configs/agent-config.json"
"${SCP[@]}" "${BUNDLE_ROOT}/scripts/monitor.sh" "root@${VPS_IP}:${REMOTE_DIR}/monitor.sh"
"${SSH[@]}" "chmod +x ${REMOTE_DIR}/monitor.sh"

# 3. Render `.env` for the Compose project on the VPS. NEVER push
#    .env to the VPS via rsync — generate a clean one with only the
#    runtime-needed values.
log "writing remote runtime env to ${REMOTE_DIR}/.env"
"${SSH[@]}" "cat > ${REMOTE_DIR}/.env <<'EOF'
HYP_VALIDATOR_KEY=${HYP_VALIDATOR_KEY}
HYP_VALIDATOR_TX_KEY=${HYP_VALIDATOR_TX_KEY}
HYP_RELAYER_KEY=${HYP_RELAYER_KEY}
R2_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID}
R2_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY}
R2_BUCKET_NAME=${R2_BUCKET_NAME}
R2_REGION=${R2_REGION:-auto}
R2_ENDPOINT_URL=${R2_ENDPOINT_URL}
BRIDGE_TELEGRAM_BOT_TOKEN=${BRIDGE_TELEGRAM_BOT_TOKEN:-}
BRIDGE_TELEGRAM_CHAT_ID=${BRIDGE_TELEGRAM_CHAT_ID:-}
EOF
chmod 600 ${REMOTE_DIR}/.env"

# 4. Bring the daemons up (or update if already running).
log "bringing up validator + relayer"
"${SSH[@]}" "cd ${REMOTE_DIR} && docker compose pull && docker compose up -d"

# 5. Wait briefly for daemons to start logging.
log "waiting 30s for daemons to settle…"
sleep 30
"${SSH[@]}" "cd ${REMOTE_DIR} && docker compose ps"
"${SSH[@]}" "cd ${REMOTE_DIR} && docker compose logs --tail 20 validator"
"${SSH[@]}" "cd ${REMOTE_DIR} && docker compose logs --tail 20 relayer"

# 6. Install monitor cron (every 15 min).
log "installing monitor cron"
"${SSH[@]}" "(crontab -l 2>/dev/null | grep -v 'etica-hyperlane/monitor.sh' ; echo '*/15 * * * * cd ${REMOTE_DIR} && ./monitor.sh >> /var/log/etica-hyperlane-monitor.log 2>&1') | crontab -"

# 7. Announce the validator on remote chains so MultisigISM can find
#    its signatures. This is a tx on each remote chain — relayer key
#    is reused since it's already funded.
log "announcing validator on remote chains (validatorAnnounce)"
"${SSH[@]}" "cd ${REMOTE_DIR} && docker compose exec -T validator ./validator announce \
  --bucket ${R2_BUCKET_NAME} --region ${R2_REGION:-auto} --folder etica \
  || true"

log "✓ daemons up. Logs: ssh -i ${VPS_SSH_KEY_PATH} root@${VPS_IP} 'cd ${REMOTE_DIR} && docker compose logs -f'"
log "Next: ./scripts/smoke-test.sh"
