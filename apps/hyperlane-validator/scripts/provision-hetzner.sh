#!/usr/bin/env bash
# Provision a Hetzner CX22 VPS for the Hyperlane validator + relayer.
#
# Inputs (from .env):
#   HETZNER_API_TOKEN — Hetzner Cloud API token (Read & Write)
#
# Outputs (written back to .env):
#   VPS_IP         — public IPv4 of the new server
#   VPS_HOSTNAME   — same as the server name we set
#   VPS_SSH_KEY_PATH — local path of the auto-generated SSH key
#
# Idempotent: if a server named etica-hyperlane already exists in
# the account, we reuse it instead of creating a new one. The local
# SSH key is regenerated only if missing.

source "$(dirname "$0")/_common.sh"
load_env
require HETZNER_API_TOKEN

SERVER_NAME="etica-hyperlane"
SERVER_TYPE="cx22"
SERVER_IMAGE="ubuntu-24.04"
SERVER_LOCATION="nbg1"  # Nuremberg
SSH_KEY_NAME="etica-hyperlane-validator"
SSH_KEY_PATH="${HOME}/.ssh/${SSH_KEY_NAME}"

API="https://api.hetzner.cloud/v1"
AUTH=(-H "Authorization: Bearer ${HETZNER_API_TOKEN}" -H "Content-Type: application/json")

# 1. Generate SSH keypair locally if missing.
if [[ ! -f "${SSH_KEY_PATH}" ]]; then
  log "generating SSH keypair at ${SSH_KEY_PATH}"
  mkdir -p "$(dirname "${SSH_KEY_PATH}")"
  ssh-keygen -t ed25519 -N '' -f "${SSH_KEY_PATH}" -C "etica-hyperlane-validator"
fi
SSH_PUBKEY="$(cat "${SSH_KEY_PATH}.pub")"

# 2. Upload SSH key to Hetzner if not already there.
existing_key_id="$(curl -s "${AUTH[@]}" "${API}/ssh_keys?name=${SSH_KEY_NAME}" | jq -r '.ssh_keys[0].id // empty')"
if [[ -z "${existing_key_id}" ]]; then
  log "uploading SSH key '${SSH_KEY_NAME}' to Hetzner"
  existing_key_id="$(curl -s "${AUTH[@]}" -X POST "${API}/ssh_keys" \
    -d "$(jq -n --arg name "${SSH_KEY_NAME}" --arg pk "${SSH_PUBKEY}" '{name:$name, public_key:$pk}')" \
    | jq -r '.ssh_key.id')"
  if [[ -z "${existing_key_id}" || "${existing_key_id}" == "null" ]]; then
    fail "Hetzner SSH key upload failed"
  fi
fi
log "Hetzner SSH key id: ${existing_key_id}"

# 3. Create server if it doesn't exist; otherwise reuse.
existing_server="$(curl -s "${AUTH[@]}" "${API}/servers?name=${SERVER_NAME}" | jq -r '.servers[0] // empty')"
if [[ -z "${existing_server}" ]]; then
  log "creating ${SERVER_TYPE} server '${SERVER_NAME}' in ${SERVER_LOCATION}"
  payload="$(jq -n \
    --arg name "${SERVER_NAME}" \
    --arg server_type "${SERVER_TYPE}" \
    --arg image "${SERVER_IMAGE}" \
    --arg location "${SERVER_LOCATION}" \
    --argjson ssh_keys "[${existing_key_id}]" \
    '{name:$name, server_type:$server_type, image:$image, location:$location, ssh_keys:$ssh_keys, start_after_create:true}')"
  resp="$(curl -s "${AUTH[@]}" -X POST "${API}/servers" -d "${payload}")"
  vps_ip="$(echo "${resp}" | jq -r '.server.public_net.ipv4.ip')"
  if [[ -z "${vps_ip}" || "${vps_ip}" == "null" ]]; then
    fail "Hetzner server create failed. Response: ${resp}"
  fi
else
  log "reusing existing server '${SERVER_NAME}'"
  vps_ip="$(echo "${existing_server}" | jq -r '.public_net.ipv4.ip')"
fi
log "VPS IP: ${vps_ip}"

# 4. Wait for SSH to be reachable.
log "waiting for SSH on ${vps_ip}…"
for _ in {1..30}; do
  if ssh -o ConnectTimeout=4 -o StrictHostKeyChecking=accept-new -i "${SSH_KEY_PATH}" "root@${vps_ip}" 'echo ok' >/dev/null 2>&1; then
    log "SSH up"
    break
  fi
  sleep 5
done

# 5. Write back to .env.
write_env VPS_IP "${vps_ip}"
write_env VPS_HOSTNAME "${SERVER_NAME}"
write_env VPS_SSH_KEY_PATH "${SSH_KEY_PATH}"

log "✓ VPS ready at ${vps_ip}. Next: ./scripts/setup-r2.sh"
