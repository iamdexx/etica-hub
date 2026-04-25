# Sourcify chain-add submission for Etica (chainId 61803)

Etica is listed in [ethereum-lists/chains](https://github.com/ethereum-lists/chains)
(and therefore in `chains.json` that Sourcify syncs from) but is **not** yet
supported by Sourcify (`supported: true`). Adding it makes every EticaHub
contract trustlessly cross-verifiable via the industry-standard multi-chain
verification service, and unlocks `forge verify-contract --verifier sourcify`
for any future deploys on Etica.

This doc is the handoff runbook for submitting a chain-add PR against
[`argotorg/sourcify`](https://github.com/argotorg/sourcify).

---

## What Sourcify requires for a new chain

From <https://docs.sourcify.dev/docs/chain-support/>:

1. A branch named `add-chain-61803` off the `staging` branch of
   `argotorg/sourcify`.
2. An entry added to
   [`services/server/src/sourcify-chains-default.json`](https://github.com/argotorg/sourcify/blob/staging/services/server/src/sourcify-chains-default.json)
   with `supported: true`.
3. At least one of the following deployed on-chain on Etica so their
   `chain-tests.spec.ts` can run a real verification round-trip against us:
   - **CreateX** at `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` (compiler
     `0.8.23+commit.f704f362`), **OR**
   - **Multicall3** at `0xcA11bde05977b3631167028862bE2a173976CA11` (compiler
     `0.8.12+commit.f00d7308`), **OR**
   - A **Storage** contract (from the stock Remix example, compiler
     `0.8.7+commit.e28d00a7`) at any address, with that address added to
     [`services/server/test/chains/sources/storage-contract-chain-addresses.json`](https://github.com/argotorg/sourcify/blob/staging/services/server/test/chains/sources/storage-contract-chain-addresses.json).

As of writing, **none of the three is deployed on Etica** — confirmed via
`eth_getCode` against `https://eticamainnet.eticascan.org`:

```
Multicall3   0xcA11…CA11   → 0x   (not deployed)
CreateX      0xba5E…a5Ed   → 0x   (not deployed)
```

The Storage contract likewise has no canonical Etica deployment.

**The submission is therefore blocked until a fixture contract is deployed on
Etica by someone with an EGAZ-funded wallet.** Once that exists, the PR can
go out and the chain-tests will pass on the Sourcify CI.

---

## Suggested fixture: Storage (lowest friction)

Storage is the stock Remix example used to seed most of Sourcify's supported
chains. It has no dependencies, compiles in isolation with solc 0.8.7, and
sits behind a single 2-function ABI (`store` / `retrieve`). Source:

```solidity
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.7;

contract Storage {
    uint256 number;

    function store(uint256 num) public {
        number = num;
    }

    function retrieve() public view returns (uint256) {
        return number;
    }
}
```

Standard-JSON input used by Sourcify's tests (unchanged across every chain
they support):
<https://github.com/argotorg/sourcify/blob/staging/services/server/test/chains/sources/storage.input.json>

### Deployment steps (for the user with an EGAZ-funded wallet)

```bash
# Use any solc-0.8.7 toolchain; an isolated forge project works:
forge init /tmp/sourcify-storage && cd /tmp/sourcify-storage
# Replace src/Counter.sol with the Storage source above.
forge build --use 0.8.7 --optimize=false

forge create \
  --rpc-url https://eticamainnet.eticascan.org \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  src/Storage.sol:Storage
```

Gas cost should be trivial (< 0.01 EGAZ at normal gas prices).

Record the resulting address and include it in step 4 below.

---

## Chain entry to submit

Paste this into `services/server/src/sourcify-chains-default.json` on the
`add-chain-61803` branch. Values are taken from our live deploy and from
`chains.json` (the existing Etica entry at chainId 61803).

```json
{
  "61803": {
    "sourcifyName": "Etica Mainnet",
    "supported": true,
    "rpc": [
      "https://eticamainnet.eticascan.org",
      "https://eticamainnet.eticaprotocol.org"
    ]
  }
}
```

No `etherscanApi` block — eticascan.org does not expose an
Etherscan/Blockscout-style verification API (see `foundry.toml` for the full
write-up). No `fetchContractCreationTxUsing` block for the same reason; the
only way to find the creation tx of an Etica contract today is a direct log
scan, which Sourcify can handle via the RPC alone.

---

## Full submission checklist

When the fixture is deployed:

1. Fork <https://github.com/argotorg/sourcify>.
2. `git checkout -b add-chain-61803 staging`
3. Add the JSON entry above to `services/server/src/sourcify-chains-default.json`.
4. Add the deployed Storage fixture address to
   `services/server/test/chains/sources/storage-contract-chain-addresses.json`:

   ```json
   "61803": "0x<YOUR-DEPLOYED-STORAGE-ADDRESS>"
   ```

5. Run the single-chain test locally:

   ```bash
   cd services/server
   NEW_CHAIN_ID=61803 npm run test:chains
   ```

6. Open PR against `argotorg/sourcify:staging`. Title:
   `feat(chains): add Etica Mainnet (61803)`. Body: link back to this doc,
   mention the deployed Storage fixture tx, and confirm
   `NEW_CHAIN_ID=61803 npm run test:chains` passed locally.

Sourcify maintainers typically review chain-adds within a few days.

---

## After Sourcify merges

Once chain 61803 is supported by Sourcify:

1. Add an `[etherscan]` block back to `packages/contracts/foundry.toml`
   (or equivalent Sourcify-verifier config, per
   <https://docs.sourcify.dev/docs/how-to-verify/>).
2. Re-run the verification pipeline against Sourcify for all 7 live
   contracts — addresses in `packages/shared/src/addresses.ts`.
3. Update this doc and the `foundry.toml` comment to reflect the new state
   of the world.

---

## Status

- [x] Chain listed in `ethereum-lists/chains` (chainId 61803)
- [x] Chain entry JSON drafted (this doc)
- [x] Storage fixture contract deployed on Etica mainnet — [`0x4e092dc78a153d3477d17915bf519b3e80f01418`](https://eticascan.org/address/0x4e092dc78a153d3477d17915bf519b3e80f01418)
- [x] `storage-contract-chain-addresses.json` entry recorded
- [x] PR submitted to `argotorg/sourcify` — [argotorg/sourcify#2758](https://github.com/argotorg/sourcify/pull/2758)
- [ ] PR merged
- [ ] `foundry.toml` + verification runbook updated to use Sourcify
