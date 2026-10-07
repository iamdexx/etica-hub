#!/usr/bin/env bash
# Cron health probe for the Hyperlane agents (run every 5 min on the agent host):
#   */5 * * * * cd /opt/eticahub/infra/hyperlane/agents && ./healthcheck.sh
#
# Checks, and posts to Telegram on failure (deduped by a state file so a
# persistent fault alerts once and once on recovery):
#   1. all three containers are Up and not restart-looping
#   2. each agent's /metrics endpoint answers
#   3. relayer wallet has gas on both chains
#   4. invariant: USDC.e totalSupply on Etica <= USDC held by the Ethereum
#      collateral router (a strict violation means unbacked supply -> pause)
#   5. relayer has not stalled on the first message from an origin: with
#      `index.from` pinned near head (see deploy.sh) the relayer's message
#      loader starts at nonce 0 on an empty DB and never advances to the first
#      indexed nonce until restarted (agents-v2.3.0 db_loader). Seen on the
#      Sepolia rehearsal: a mint sat indexed-but-unprocessed for 11 min until
#      `docker restart`. Detected from /metrics and fixed with one restart;
#      afterwards the DB remembers the highest nonce.
# Needs: docker, curl, python3 (stdlib only). Reads ./.env.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[[ -f .env ]] && set -a && . ./.env && set +a

ROUTE_FILE="../registry/deployments/warp_routes/USDC/etica-config.yaml"
STATE=".healthcheck.state"
USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
problems=()

# Comma-separated lists; `rpc` walks each list until an endpoint answers.
ETH_RPC="${ETHEREUM_RPC_URLS:-https://gateway.tenderly.co/public/mainnet,https://rpc.mevblocker.io,https://eth.drpc.org,https://ethereum-rpc.publicnode.com}"
ETI_RPC="${ETICA_RPC_URLS:-https://eticamainnet.eticaprotocol.org,https://rpc2.etica-stats.org}"

rpc() { # rpc <url[,url...]> <method> <params-json>
  local url out
  for url in ${1//,/ }; do
    out="$(curl -sS -m 15 -X POST "$url" -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" 2>/dev/null |
      python3 -c 'import sys,json; r=json.load(sys.stdin); print(r["result"])' 2>/dev/null)" && { echo "$out"; return 0; }
  done
  echo ""
}
hex2dec() { python3 -c 'import sys; v=sys.argv[1]; print(int(v,16) if v.startswith("0x") and len(v)>2 else -1)' "$1"; }
pad() { printf '%064s' "${1#0x}" | tr ' ' 0; }

# 1. containers
for c in hl-validator-ethereum hl-validator-etica hl-relayer; do
  st="$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$c" 2>/dev/null || echo "missing 0")"
  status="${st% *}"; restarts="${st#* }"
  [[ "$status" == "running" ]] || problems+=("$c is $status")
  [[ "${restarts:-0}" -lt 5 ]] || problems+=("$c restarted ${restarts}x")
done

# 2. metrics endpoints
for p in 9090 9091 9092; do
  curl -sf -m 5 "http://127.0.0.1:$p/metrics" >/dev/null || problems+=("metrics :$p not responding")
done

# 3. relayer gas
RELAYER_ADDR="${RELAYER_ADDRESS:-}"
if [[ -n "$RELAYER_ADDR" ]]; then
  for pair in "ethereum|$ETH_RPC|${MIN_RELAYER_ETH:-0.03}|ETH" "etica|$ETI_RPC|${MIN_RELAYER_EGAZ:-10}|EGAZ"; do
    IFS='|' read -r chain url min sym <<<"$pair"
    wei="$(hex2dec "$(rpc "$url" eth_getBalance "[\"$RELAYER_ADDR\",\"latest\"]")")"
    if [[ "$wei" -lt 0 ]]; then problems+=("$chain RPC unreachable"); continue; fi
    bal="$(python3 -c "print($wei/1e18)")"
    python3 -c "import sys; sys.exit(0 if $wei/1e18 >= $min else 1)" || problems+=("relayer low gas on $chain: $bal $sym < $min")
  done
else
  problems+=("RELAYER_ADDRESS unset; skipping gas check")
fi

# 4. supply invariant
if [[ -f "$ROUTE_FILE" ]]; then
  read -r ETH_ROUTER ETI_ROUTER < <(python3 - "$ROUTE_FILE" <<'EOF'
import sys,re
eth=eti=""
cur=None
for line in open(sys.argv[1]):
    m=re.match(r'\s*-\s*addressOrDenom:\s*"?(0x[0-9a-fA-F]{40})', line)
    if m: cur=m.group(1); continue
    m=re.match(r'\s*chainName:\s*(\w+)', line)
    if m and cur:
        if m.group(1)=="ethereum": eth=cur
        if m.group(1)=="etica": eti=cur
print(eth, eti)
EOF
)
  if [[ -n "$ETH_ROUTER" && -n "$ETI_ROUTER" ]]; then
    locked="$(hex2dec "$(rpc "$ETH_RPC" eth_call "[{\"to\":\"$USDC\",\"data\":\"0x70a08231$(pad "$ETH_ROUTER")\"},\"latest\"]")")"
    supply="$(hex2dec "$(rpc "$ETI_RPC" eth_call "[{\"to\":\"$ETI_ROUTER\",\"data\":\"0x18160ddd\"},\"latest\"]")")"
    if [[ "$locked" -ge 0 && "$supply" -ge 0 ]]; then
      [[ "$supply" -le "$locked" ]] || problems+=("INVARIANT BROKEN: USDC.e supply $supply > locked USDC $locked — pause the route")
    else
      problems+=("could not read supply/locked (eth=$locked, etica=$supply)")
    fi
  fi
fi

# 5. relayer message loader stuck at nonce 0 while messages are indexed
metrics="$(curl -sf -m 5 http://127.0.0.1:9090/metrics 2>/dev/null || true)"
if [[ -n "$metrics" ]]; then
  stuck="$(python3 - <<'PY' <<<"$metrics"
import re, sys
stored, loader = {}, {}
for line in sys.stdin:
    m = re.match(r'hyperlane_contract_sync_stored_events\{([^}]*)\} (\d+)', line)
    if m and 'data_type="dispatched_messages"' in m.group(1):
        stored[re.search(r'chain="(\w+)"', m.group(1)).group(1)] = int(m.group(2))
    m = re.match(r'hyperlane_last_known_message_nonce\{([^}]*)\} (\d+)', line)
    if m and 'phase="db_loader_loop"' in m.group(1):
        loader[re.search(r'origin="(\w+)"', m.group(1)).group(1)] = int(m.group(2))
print(" ".join(c for c, n in stored.items() if n > 0 and loader.get(c, 0) == 0))
PY
)"
  if [[ -n "$stuck" ]]; then
    docker restart hl-relayer >/dev/null 2>&1 || true
    problems+=("relayer loader stuck at nonce 0 with messages indexed from: $stuck — restarted hl-relayer")
  fi
fi

# report (edge-triggered)
prev="$(cat "$STATE" 2>/dev/null || echo ok)"
if ((${#problems[@]})); then
  msg="⚠️ Hyperlane USDC bridge health%0A$(printf '• %s%%0A' "${problems[@]}")"
  echo "${problems[*]}" >&2
  state=bad
else
  msg="✅ Hyperlane USDC bridge recovered"
  state=ok
fi
if [[ "$state" != "$prev" && -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
  curl -sS -m 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data "text=$(printf '%b' "${msg//%0A/\\n}")" >/dev/null || true
fi
echo "$state" > "$STATE"
[[ "$state" == ok ]]
