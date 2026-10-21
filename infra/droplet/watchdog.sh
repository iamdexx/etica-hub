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
  [[ -n "${ALERT_TELEGRAM_BOT_TOKEN:-}" && -n "${ALERT_TELEGRAM_CHAT_ID:-}" ]] || return 0
  curl -s --max-time 10 -X POST "https://api.telegram.org/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${ALERT_TELEGRAM_CHAT_ID}" --data-urlencode text="[explorer] $*" >/dev/null || true
}

restart_sync() {
  echo "$(date -u +%FT%TZ) restarting SynchronizeBlocks ($*)"
  docker compose exec -T engine pm2 restart SynchronizeBlocks >/dev/null 2>&1 \
    || docker compose restart engine >/dev/null 2>&1
}

head=$(chain_head) || { alert "no Etica RPC answered eth_blockNumber"; exit 0; }
db=$(db_head) || { alert "postgres not answering; restarting db + engine"; docker compose restart db engine >/dev/null 2>&1; exit 0; }
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
  (( prev_alerting == 1 )) || alert "indexer $lag blocks behind (db $db, chain $head)"
elif (( prev_alerting == 1 )); then
  alert "indexer recovered: $lag blocks behind"
fi
echo "$db $alerting" > "$STATE"

# Nightly backup (first run after 03:00 UTC each day).
mkdir -p data/backups
today="data/backups/eticaenginedb-$(date -u +%F).sql.gz"
if [[ ! -f "$today" && 10#$(date -u +%H) -ge 3 ]]; then
  docker compose exec -T db pg_dump -U etica -d eticaenginedb | gzip > "$today.tmp" && mv "$today.tmp" "$today" \
    && find data/backups -name '*.sql.gz' -mtime +"$BACKUP_KEEP" -delete \
    || { rm -f "$today.tmp"; alert "nightly pg_dump failed"; }
fi
