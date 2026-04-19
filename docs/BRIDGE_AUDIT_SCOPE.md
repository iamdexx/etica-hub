# EticaHub Bridge — Audit Scoping Document

This document describes what an independent auditor should review before the
bridge is deployed to mainnet with real TVL. It is intentionally narrow: only
the on-chain contracts that can move value, and the off-chain pieces that can
authorize them to do so.

Nothing in EticaSwap V2 (Phase 1), the ETX reward stack (Phase 2a), or the
Research Hub (Phase 2b) is in the bridge audit scope. Those phases have their
own invariants and can be reviewed separately.

## 1. In Scope

### 1.1 On-chain contracts (the only things holding or minting value)

| Contract | File | Chain side |
|---|---|---|
| `EticaBridgeVault` | `packages/contracts/src/bridge/EticaBridgeVault.sol` | Etica (lock side) |
| `EthereumBridgeMinter` | `packages/contracts/src/bridge/EthereumBridgeMinter.sol` | Ethereum (mint side) |
| `WrappedETI` (wETI) | `packages/contracts/src/bridge/WrappedETI.sol` | Ethereum |
| `MultisigVerifier` | `packages/contracts/src/bridge/MultisigVerifier.sol` | both sides |
| `IAttestationVerifier` | `packages/contracts/src/bridge/IAttestationVerifier.sol` | interface |

### 1.2 Off-chain surfaces that feed the contracts

| Component | File | Purpose |
|---|---|---|
| Canonical digest | `apps/relayer/src/digest.ts` | Must match `buildDigest` on both contracts, field-for-field. A mismatch silently produces invalid attestations. |
| Signer | `apps/relayer/src/signer.ts` | Per-validator process. Signs EIP-191 `personal_sign` over the canonical digest. |
| Coordinator | `apps/relayer/src/coordinator.ts` | Aggregates signatures in memory; cannot forge signatures, only censor. |

### 1.3 Tests

- `packages/contracts/test/Bridge.t.sol` — 21 tests, including
  `testRoundTripPreservesInvariant` which walks deposit → mint → burn →
  withdraw and asserts the cross-chain solvency invariant at every step.
- `apps/relayer/test/digest.test.ts`, `coordinator.test.ts` — 11 tests.

## 2. Out of Scope

- EticaSwap V2 contracts (Factory / Pair / Router / WEGAZ).
- ETX token, MasterChef, xETXVault, FeeRouter.
- ResearchSubscription contract.
- Any frontend code in `apps/web`. Frontend bugs cannot authorize contract
  actions without a valid signature set, and the on-chain `MultisigVerifier` is
  the authoritative gate.

## 3. Trust Model (MVP)

- **M-of-N ECDSA multisig**, default 2-of-3. Validator set is configured at
  contract construction and can be rotated by the admin multisig through a
  governance path that is **not yet in scope for MVP** (tracked for Phase 3.5).
- **Coordinator is trusted only for liveness, not safety.** It cannot forge a
  signature. A malicious coordinator can: (a) censor signatures (denial of
  service), (b) lie about `ready: true` when aggregation is incomplete (client
  will then submit a claim that fails on chain, costing only gas, no funds).
- **Validators are trusted for correctness.** If a threshold of validators
  sign a payload whose `srcTxHash` did not occur, funds can be minted against
  nothing. This is the standard trust assumption of a multisig bridge. Pluggable
  `IAttestationVerifier` is the upgrade path to a light-client or ZK proof.
- **No user key ever reaches the coordinator or any Devin infrastructure.**
  Validator keys live only on the operator host where the signer runs.

## 4. Invariants the Auditor Should Confirm

### 4.1 Solvency (the most important one)

> For every `(srcChainId, srcTxHash, nonce)` tuple, at most one claim can be
> processed on the destination chain, and the value minted (or unlocked) equals
> the value locked (or burned) minus exactly one destination-side fee.

- **Single-fee-point model.** Deposit/burn lock/burn the gross amount. Mint/
  withdraw split into `(netRecipient, feeTreasury)`. No fee is charged on the
  source side. See the comment block at the top of both `EticaBridgeVault.sol`
  and `EthereumBridgeMinter.sol`.
- **Pointwise cross-chain solvency.** `vault.ETI balance == wETI.totalSupply`
  must hold at every step, not just at equilibrium. `testRoundTripPreservesInvariant`
  asserts this after deposit, after mint, after burn, after withdraw.
- **Replay protection.** `processed[nonce]` on each side flips to `true` on a
  successful claim and short-circuits any replay. Confirm there is no code path
  that can clear this flag without a full governance action.

### 4.2 Signature aggregation

- Signatures are EIP-191 (`personal_sign`) over `keccak256(abi.encode(srcChainId, dstChainId, srcTxHash, nonce, token, amount, recipient))`.
- The on-chain verifier expects signers in strictly ascending address order for
  O(n) dedup. A malicious relayer/coordinator cannot violate this (it's a
  client-supplied ordering validated on chain), but **the frontend must sort
  signatures ascending** before submission; `ClaimCard.sigsAscending` does this.
- `MultisigVerifier.threshold` cannot be lowered below 1 and cannot exceed the
  validator count.

### 4.3 wETI token behavior

- `WrappedETI.mint` is gated to the minter role only (`onlyMinter`).
- `WrappedETI.burnFrom` enforces both the minter gate **and** the ERC-20
  allowance via `_spendAllowance`, so a malicious minter cannot drain arbitrary
  user balances.
- Standard OpenZeppelin ERC-20 behavior otherwise (no rebasing, no transfer
  hooks).

### 4.4 Fees

- Fee treasury address is settable by admin only; cannot be a contract that
  reverts on receive (no native transfer from these contracts — all values
  are ERC-20 on both sides, so reentrancy via receive is not a concern).
- Fee basis points are capped in `MAX_FEE_BPS` (confirm the exact constant in
  code matches ops policy).

## 5. Known Non-Goals / Deferred

- **No automatic claim submission.** The user manually submits the destination
  tx. A malicious UI could prompt a user to sign the wrong destination, but this
  cannot move funds that the user hasn't already locked.
- **No cross-chain message protocol integration** (CCIP, LayerZero, Hyperlane).
  Pluggable `IAttestationVerifier` is the integration surface when chosen.
- **No validator slashing.** Misbehaving validators must be rotated manually.
- **No congestion / queue / per-block cap.** Acceptable for MVP TVL.
- **Coordinator is in-memory and single-instance.** Persistence and HA come in
  Phase 3.5.

## 6. Suggested Test Matrix for Auditor

- Deposit lock/burn with fee = 0, fee = max, random fees in between.
- Try to mint with M-1 signatures (must revert).
- Try to mint with M signatures but one is out of order (must revert).
- Try to mint with M signatures but one is duplicated (must revert).
- Try to replay a processed nonce (must revert).
- Try to `burnFrom` without allowance (must revert).
- Try to `burnFrom` with allowance from a non-minter caller (must revert).
- Randomized differential test of on-chain `buildDigest` vs TS digest across
  full field space (amount, chain IDs, addresses, nonces).
- Validator rotation scenarios (add, remove, threshold change) under admin
  multisig. Note: admin multisig integration is Phase 3.5 — confirm no unsafe
  default path exists in MVP.

## 7. Ops Guidance (to hand to the auditor for context)

- Validator keys are hot but operator-hosted. Recommend hardware key backing
  (HSM / cloud KMS). Not enforced in code.
- Fee treasury should be a multisig under the EticaHub DAO once one exists.
  Until then, it's the `feeToSetter` address in `packages/shared/src/addresses.ts`.
- The wETI contract does not support `permit`. Integrations that expect EIP-2612
  permit will need to fall back to `approve`.

## 8. Deliverables Expected from Audit

1. Written report covering in-scope contracts + off-chain digest parity.
2. Confirmation (or refutation) of the four invariants in §4.
3. Severity-ranked findings with reproducer tests where applicable.
4. Sign-off on MVP trust model or a concrete upgrade path.

No deploy to any chain will happen before all high/critical findings are fixed
and re-reviewed.
