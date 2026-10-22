#!/usr/bin/env bash
# Explorer indexer watchdog (cron every 5 min):
#   */5 * * * * cd /opt/eticahub/infra/droplet && ./watchdog.sh >> /var/log/explorer-watchdog.log 2>&1
#
# The engine's SynchronizeBlocks loop stops advancing after a single bad RPC
# reply ("Invalid JSON RPC response") while pm2 still reports it online; it
# sat 5 days behind on 2026-10-16 without anyone noticing. This compares the
# indexed head with the chain head and:
#   - restarts SynchronizeBlocks when the DB head has not moved since the last
#     run while the chain has (stall); a large but shrinking lag is left alone
#   - posts a Telegram alert (deduped via state file) when lag > ALERT_LAG,
#     and once on recovery
#   - keeps a nightly pg_dump in ./data/backups (BACKUP_KEEP days)
# Reads ./.env (PG_PASSWORD, optional ALERT_TELEGRAM_BOT_TOKEN/ALERT_TELEGRAM_CHAT_ID,
# ETICA_RPC_URLS comma-separated).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[[ -f .env ]] && set -a && . ./.env && set +a
umask 077
exec 9>.watchdog.lock
flock -n 9 || exit 0

STATE=".watchdog.state"
ALERT_LAG="${ALERT_LAG:-100}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"
RPCS="${ETICA_RPC_URLS:-${ETICA_RPC_URL:-https://eticamainnet.eticaprotocol.org},https://61803.rpc.thirdweb.com,https://eticamainnet.eticascan.org}"

chain_head() {
  local url r
  for url in ${RPCS//,/ }; do
    r=$(curl -s --max-time 8 -X POST -H content-type:application/json \
      -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$url" \
      | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["result"],16))' 2>/dev/null) && [[ -n "$r" ]] && { echo "$r"; return 0; }
  done
  return 1
}

db_head() {
  docker compose exec -T db psql -U etica -d eticaenginedb -Atc "select coalesce(max(number),0) from blocks" 2>/dev/null
}

alert() {
  echo "$(date -u +%FT%TZ) ALERT: $*"
  [[ -n "${ALERT_TELEGRAM_BOT_TOKEN:-}" && -n "${ALERT_TELEGRAM_CHAT_ID:-}" ]] || return 1
  curl -sf --max-time 10 -X POST "https://api.telegram.org/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${ALERT_TELEGRAM_CHAT_ID}" --data-urlencode text="[explorer] $*" >/dev/null
}

backup() {
  mkdir -p data/backups && chmod 700 data/backups
  local today="data/backups/eticaenginedb-$(date -u +%F).sql.gz"
  [[ ! -f "$today" && 10#$(date -u +%H) -ge 3 ]] || return 0
  if docker compose exec -T db pg_dump -U etica -d eticaenginedb | gzip > "$today.tmp" \
    && [[ ${PIPESTATUS[0]} -eq 0 ]]; then
    mv "$today.tmp" "$today"
    find data/backups -name '*.sql.gz' -mtime +"$BACKUP_KEEP" -delete
  else
    rm -f "$today.tmp"
    alert "nightly pg_dump failed"
  fi
}

restart_sync() {
  echo "$(date -u +%FT%TZ) restarting SynchronizeBlocks ($*)"
  docker compose exec -T engine pm2 restart SynchronizeBlocks >/dev/null 2>&1 \
    || docker compose restart engine >/dev/null 2>&1
}

db=$(db_head) || { alert "postgres not answering; restarting db + engine"; docker compose restart db engine >/dev/null 2>&1; exit 0; }
backup
head=$(chain_head) || { alert "no Etica RPC answered eth_blockNumber"; exit 0; }
prev_db=0; prev_alerting=0
[[ -f "$STATE" ]] && read -r prev_db prev_alerting < "$STATE"
lag=$(( head - db ))
echo "$(date -u +%FT%TZ) chain=$head db=$db lag=$lag"

# Only a static DB head is a stall; a large but shrinking lag is a catch-up.
if (( db == prev_db && head > db )); then
  restart_sync "db head static at $db for one interval"
fi

alerting=0
if (( lag > ALERT_LAG )); then
  alerting=1
  if (( prev_alerting != 1 )); then
    alert "indexer $lag blocks behind (db $db, chain $head)" || alerting=0
  fi
elif (( prev_alerting == 1 )); then
  alert "indexer recovered: $lag blocks behind" || alerting=1
fi
echo "$db $alerting" > "$STATE"


# apps/explorer-api (hub.* full-chain index): restart when its head is static
# while the chain moves; alert when it is more than ALERT_LAG behind.
hub=$(curl -s --max-time 8 http://127.0.0.1:80/hub/health | python3 -c 'import sys,json;print(json.load(sys.stdin)["head"] or 0)' 2>/dev/null) || hub=""
if [[ -n "$hub" ]]; then
  prev_hub=0; [[ -f .watchdog.hub ]] && read -r prev_hub < .watchdog.hub
  hub_lag=$(( head - hub ))
  echo "$(date -u +%FT%TZ) hub=$hub hub_lag=$hub_lag"
  if (( hub == prev_hub && head > hub )); then
    echo "$(date -u +%FT%TZ) restarting explorer-api (head static at $hub)"
    docker compose restart explorer-api >/dev/null 2>&1
  fi
  hub_alerting=0; [[ -f .watchdog.hub.alert ]] && hub_alerting=1
  if (( hub_lag > ALERT_LAG && hub == prev_hub )); then
    (( hub_alerting == 0 )) && alert "explorer-api stalled $hub_lag blocks behind (hub $hub, chain $head)" && touch .watchdog.hub.alert
  elif (( hub_lag <= ALERT_LAG && hub_alerting == 1 )); then
    alert "explorer-api recovered: $hub_lag blocks behind" && rm -f .watchdog.hub.alert
  fi
  echo "$hub" > .watchdog.hub
else
  echo "$(date -u +%FT%TZ) explorer-api health not answering"
fi
