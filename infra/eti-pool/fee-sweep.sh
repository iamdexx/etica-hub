#!/usr/bin/env bash
# Sweep the ETI pool's accumulated 0.5% fee from the BatchedPayments contract to the treasury.
# eticapool parks all minted ETI (miners' share + pool fee) in BatchedPayments and has no fee address,
# so the fee is whatever the contract holds above what miners are still owed. Keeps a 10% buffer.
# Owed is read straight from the pool's Mongo (all miners, not just the active list the API shows).
# Runs weekly from root's crontab on the droplet. Usage: fee-sweep.sh [--dry-run]
set -euo pipefail

RPC=https://rpc.eticahub.com
ETI=0x34c61EA91bAcdA647269d4e310A86b875c09946f
BATCHED=0x2ab929Ab41b4ba22D66DDeAB075F615888fd050a
TREASURY=0xB2B4bC9d02970A55efF64C2D84c622c87967C19D
MIN_SWEEP_ETI=1
ENV_FILE=/root/.eti-pool.env
HERE=$(cd "$(dirname "$0")" && pwd)

# balanceOf(BATCHED) via raw eth_call, decoded in python (no 64-bit bash arithmetic anywhere below)
calldata="0x70a08231000000000000000000000000${BATCHED#0x}"
balance=$(curl -sf -m 15 "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$ETI\",\"data\":\"$calldata\"},\"latest\"]}" \
  | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"], 16))')

owed=$(docker cp "$HERE/owed.js" eticapool-mongodb-1:/tmp/owed.js >/dev/null && docker exec eticapool-mongodb-1 sh -c \
  'mongo -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin tokenpool_production --quiet /tmp/owed.js' | tail -1)

read -r sweep sendit < <(python3 -c "
b=int('$balance'); o=int(float('$owed')); s=max(0,(b-o)*9//10)
print(s, 1 if s >= $MIN_SWEEP_ETI*10**18 else 0)")
printf '%s balance=%s owed=%s sweep=%s (wei)\n' "$(date -u +%FT%TZ)" "$balance" "$owed" "$sweep"

if [[ "$sendit" != 1 ]]; then echo "below ${MIN_SWEEP_ETI} ETI, nothing to sweep"; exit 0; fi
if [[ "${1:-}" == "--dry-run" ]]; then echo "dry run, not sending"; exit 0; fi

docker cp "$HERE/send-fee.js" eti-pool-app:/tmp/send-fee.js >/dev/null
# key goes over stdin, never in argv
grep '^ETI_PAY_KEY=' "$ENV_FILE" | cut -d= -f2 | docker exec -i -e NODE_PATH=/app/node_modules eti-pool-app node /tmp/send-fee.js "$RPC" "$BATCHED" "$ETI" "$TREASURY" "$sweep"
