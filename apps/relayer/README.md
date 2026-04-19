# @etica-hub/relayer

Bridge relayer for the Phase 3 Etica ↔ Ethereum lock-mint bridge.

Two long-running modes in one package:

| Mode          | Purpose                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `coordinator` | HTTP server that aggregates validator signatures per bridge request.    |
| `signer`      | Per-validator process: watches source chain for bridge events, signs the canonical digest, posts to the coordinator. |

## Digest (must match the on-chain verifier)

```
digest = keccak256(abi.encode(
  uint256 srcChainId,
  uint256 dstChainId,
  bytes32 srcTxHash,
  bytes32 nonce,
  address token,
  uint256 amount,
  address recipient
))
```

Validators sign with EIP-191 `personal_sign` — i.e. `eth_sign` over the
bare digest, producing 65-byte `(r, s, v)` signatures. The on-chain
`MultisigVerifier` re-wraps the digest in the `"\x19Ethereum Signed Message:\n32"`
envelope and `ecrecover`s each signature against the allowlisted validator set.

## Environment

**Coordinator:**

```bash
RELAYER_MODE=coordinator
COORDINATOR_PORT=4000
COORDINATOR_THRESHOLD=2
COORDINATOR_VALIDATORS=0xAAAA...,0xBBBB...,0xCCCC...
```

**Signer (one process per validator per direction):**

```bash
RELAYER_MODE=signer
RELAYER_DIRECTION=etica-to-eth          # or eth-to-etica
RELAYER_SRC_CHAIN_ID=61803
RELAYER_SRC_RPC_URL=https://eticamainnet.eticascan.org
RELAYER_SRC_CONTRACT=0x...              # vault (etica-to-eth) or minter (eth-to-etica)
RELAYER_DST_CHAIN_ID=1
RELAYER_DST_RPC_URL=https://...
RELAYER_DST_CONTRACT=0x...              # mirror side
RELAYER_TOKEN=0x34c61EA91bAcdA647269d4e310A86b875c09946f
VALIDATOR_PRIVATE_KEY=0x...             # validator key — NEVER commit
COORDINATOR_URL=http://coordinator:4000
RELAYER_START_BLOCK=0                   # optional; defaults to tip
RELAYER_POLL_MS=8000                    # optional
```

## Submitting attestations on-chain

Once the coordinator reports `ready: true` for a nonce, anyone can fetch
`GET /signatures/:nonce` and submit the resulting `bytes[]` to the
destination contract:

- Etica → Ethereum: `EthereumBridgeMinter.mint(srcChainId, srcTxHash, nonce, amount, recipient, signatures)`
- Ethereum → Etica: `EticaBridgeVault.withdraw(srcChainId, srcTxHash, nonce, amount, recipient, signatures)`

The bridge UI handles this automatically; for a fully manual submission the
signatures array must be sorted ascending by signer address (the on-chain
verifier enforces strict ordering to de-duplicate).

## Scripts

```bash
pnpm --filter @etica-hub/relayer build       # tsc compile
pnpm --filter @etica-hub/relayer typecheck
pnpm --filter @etica-hub/relayer test        # vitest (digest + coordinator)
```

## Security notes

- Validator keys live **only** on the validator's own host. The coordinator
  never sees or stores a private key.
- The coordinator is a convenience layer. The on-chain contract is the
  source of truth — a misbehaving coordinator cannot forge attestations,
  because it can't produce valid ECDSA signatures from validator keys.
- The store is in-memory. Restarting the coordinator drops pending
  sigs. Production hardening: SQLite/Postgres persistence, rate limits,
  authenticated validator endpoints.
