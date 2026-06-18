#!/usr/bin/env bash
# Health check for the Hyperlane validator + relayer daemons.
#
# Runs every 15 min on the VPS via cron (installed by
# install-on-vps.sh). Pings Telegram on:
#
#   1. Either container is not running.
#   2. Validator hasn't logged "Storing checkpoint" / "Submitted index"
#      style messages in the last 30 min (signing has stalled).
#   3. Relayer has logged "ERROR" lines in the last 30 min.
#
# Reuses BRIDGE_TELEGRAM_BOT_TOKEN + BRIDGE_TELEGRAM_CHAT_ID env vars
# from the bridge-watcher (set in /opt/etica-hyperlane/.env on the
# VPS by install-on-vps.sh).

set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="$(pwd)/.env"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

alert() {
  local msg="$1"
  echo "[monitor] ALERT: ${msg}" >&2
  if [[ -n "${BRIDGE_TELEGRAM_BOT_TOKEN:-}" && -n "${BRIDGE_TELEGRAM_CHAT_ID:-}" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${BRIDGE_TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${BRIDGE_TELEGRAM_CHAT_ID}" \
      -d "parse_mode=Markdown" \
      -d "text=🚨 *Etica Hyperlane validator/relayer*: ${msg}" \
      >/dev/null
  fi
}

# 1. Containers running?
for svc in etica-hyperlane-validator etica-hyperlane-relayer; do
  if ! docker inspect -f '{{.State.Running}}' "${svc}" 2>/dev/null | grep -q true; then
    alert "container \`${svc}\` is not running"
  fi
done

# 2. Validator signed a checkpoint recently?
since=$(date -u -d '30 min ago' +'%Y-%m-%dT%H:%M:%S' 2>/dev/null || date -u -v-30M +'%Y-%m-%dT%H:%M:%S')
if ! docker logs etica-hyperlane-validator --since "${since}" 2>&1 | grep -qiE 'storing checkpoint|submitted index|signed'; then
  alert "validator has NOT signed a checkpoint in the last 30 min"
fi

# 3. Relayer errors recently?
err_count="$(docker logs etica-hyperlane-relayer --since "${since}" 2>&1 | grep -c -iE 'ERROR|panic' || true)"
if [[ "${err_count}" -gt 5 ]]; then
  recent="$(docker logs etica-hyperlane-relayer --since "${since}" 2>&1 | grep -iE 'ERROR|panic' | head -3 | tr '\n' '|')"
  alert "relayer logged ${err_count} ERROR lines in last 30 min: ${recent}"
fi

echo "[monitor] $(date -u +'%Y-%m-%dT%H:%M:%SZ') ok"
