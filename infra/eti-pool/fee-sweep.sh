#!/usr/bin/env bash
# Sweep the ETI pool's accumulated 0.5% fee from the BatchedPayments contract to the treasury.
# eticapool parks all minted ETI (miners' share + pool fee) in BatchedPayments and has no fee address,
# so the fee is whatever the contract holds above what miners are still owed. Keeps a 10% buffer.
# Runs weekly from root's crontab on the droplet. Usage: fee-sweep.sh [--dry-run]
set -euo pipefail

RPC=https://eticamainnet.eticascan.org
ETI=0x34c61EA91bAcdA647269d4e310A86b875c09946f
BATCHED=0x2ab929Ab41b4ba22D66DDeAB075F615888fd050a
TREASURY=0xB2B4bC9d02970A55efF64C2D84c622c87967C19D
POOL_API=http://127.0.0.1:8090/api/v2/pool
MIN_SWEEP_ETI=1
ENV_FILE=/root/.eti-pool.env
FOUNDRY=ghcr.io/foundry-rs/foundry:stable

cast() { docker run --rm --network host -e PK --entrypoint cast ${FOUNDRY} "$@"; }

balance_hex=$(cast call --rpc-url "$RPC" "$ETI" "balanceOf(address)(uint256)" "$BATCHED")
balance=$(python3 -c "import sys; print(int(sys.argv[1].split()[0]))" "$balance_hex")

owed=$(curl -sf -m 15 "$POOL_API/miners" | python3 -c '
import json, sys
d = json.load(sys.stdin)
miners = d.get("miners", d) if isinstance(d, dict) else d
total = 0
for m in miners:
    total += max(0, int(float(m.get("alltimeTokenBalance", 0) or 0)) - int(float(m.get("tokensReceived", 0) or 0)))
print(total)')

sweep=$(python3 -c "b=$balance; o=$owed; s=(b-o)*9//10; print(s if s>0 else 0)")
printf '%s balance=%s owed=%s sweep=%s (wei)\n' "$(date -u +%FT%TZ)" "$balance" "$owed" "$sweep"

if (( sweep < MIN_SWEEP_ETI * 10**18 )); then echo "below ${MIN_SWEEP_ETI} ETI, nothing to sweep"; exit 0; fi
if [[ "${1:-}" == "--dry-run" ]]; then echo "dry run, not sending"; exit 0; fi

PK=$(grep ^ETI_PAY_KEY= "$ENV_FILE" | cut -d= -f2)
export PK
tx=$(cast send --rpc-url "$RPC" --private-key "$PK" --legacy --gas-price 20gwei --json \
  "$BATCHED" "send(address,address,uint256)" "$ETI" "$TREASURY" "$sweep" | python3 -c 'import json,sys; j=json.load(sys.stdin); print(j["transactionHash"], "status", j["status"])')
echo "sent $tx"
