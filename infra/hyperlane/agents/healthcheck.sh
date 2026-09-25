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
# Needs: docker, curl, python3 (stdlib only). Reads ./.env.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[[ -f .env ]] && set -a && . ./.env && set +a

ROUTE_FILE="../registry/deployments/warp_routes/USDC/etica-config.yaml"
STATE=".healthcheck.state"
USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
problems=()

first_rpc() { echo "${1%%,*}"; }
ETH_RPC="$(first_rpc "${ETHEREUM_RPC_URLS:-https://ethereum-rpc.publicnode.com}")"
ETI_RPC="$(first_rpc "${ETICA_RPC_URLS:-https://eticamainnet.eticaprotocol.org}")"

rpc() { # rpc <url> <method> <params-json>
  curl -sS -m 15 -X POST "$1" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" |
    python3 -c 'import sys,json; r=json.load(sys.stdin); print(r.get("result",""))' 2>/dev/null
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
