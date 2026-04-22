# Verified contract manifests

Each `0x<lowercased-address>.json` in this directory is a verified-source
manifest for a contract deployed on Etica mainnet (chain id 61803). The
explorer reads these at request time via `loadVerified(addr)` in
`apps/web/src/lib/verified.ts` and renders the "Source Code" section +
"Verified" badge on `/explorer/address/<addr>`.

## Schema

See `apps/web/src/lib/verified.ts` for the `VerifiedContract` interface.
Minimal shape:

```json
{
  "address": "0x…",
  "name": "ContractName",
  "compilerVersion": "0.8.26+commit.8a97fa7a",
  "optimizer": { "enabled": true, "runs": 1000000 },
  "evmVersion": "paris",
  "sources": { "src/path/File.sol": { "content": "…" } },
  "abi": [ … ],
  "verifiedAt": "2026-04-22T…",
  "bytecodeMatch": "exact | with-immutables | with-metadata-hash"
}
```

## Adding a new verified contract

Operators seed new manifests via the CLI at `apps/web/scripts/verify-contract.mjs`:

```bash
cd apps/web
node scripts/verify-contract.mjs \
  --address 0x… \
  --artifact ../../packages/<pkg>/out/MyContract.sol/MyContract.json \
  --contracts-root ../../packages/<pkg>
```

The script fetches the on-chain runtime bytecode, compares it against the
compiled `deployedBytecode` at three levels (`exact` → `with-immutables`
→ `with-metadata-hash`), reads the source files listed in the artifact's
metadata, and writes the manifest into this directory. Commit the
resulting JSON and open a PR.

## Bytecode match levels

- **exact** — byte-for-byte identical. Strongest.
- **with-immutables** — identical after zeroing out the immutable slots
  solc reports in `deployedBytecode.immutableReferences`. Expected for
  contracts that set addresses or config via constructor.
- **with-metadata-hash** — identical after stripping the CBOR metadata
  tail solc appends (its "auxdata" — the IPFS hash of the metadata.json
  and the compiler version). Required for any package compiled with
  `bytecode_hash = "ipfs"` (the foundry default) where the local build
  generates a different IPFS hash than the deploy-time build.
