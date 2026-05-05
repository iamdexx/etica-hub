// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Veto-reason enum shared across the bridge contracts. Order is part
/// of the public ABI; do not reorder, only append.
enum VetoReason {
    NONE,
    OPERATOR_MANUAL,
    BOT_DEPOSIT_NOT_FOUND,
    BOT_AMOUNT_MISMATCH,
    BOT_RECIPIENT_MISMATCH,
    FRAUD_PROVER_MERKLE,
    HYPERLANE_REJECT
}

/// @notice Canonical bridge message. Constructed on the source chain at
/// deposit time; its `keccak256(abi.encode(...))` is the Merkle leaf the
/// fraud-prover module verifies against attested Etica block roots.
struct BridgeMessage {
    bytes32 nonce;
    uint32 srcDomain;
    uint32 destDomain;
    address sender;
    address recipient;
    uint128 amount;
    uint64 srcBlockNumber;
    uint64 timestamp;
}

/// @notice Minimal cross-contract surface that `OptimisticVetoModule` and
/// `FraudProverModule` rely on. The full `BridgeMinter` is implemented in a
/// later impl PR; this interface is sized to the calls those modules make.
interface IBridgeMinter {
    /// @notice Operator-driven veto. Called by `OptimisticVetoModule` when
    /// the watcher bot or a backup vetoer rejects a pending claim.
    function vetoClaimManual(bytes32 nonce, VetoReason reason) external;

    /// @notice Fraud-proof veto. Called by `FraudProverModule` once it has
    /// verified a Merkle proof showing the on-Etica deposit doesn't match
    /// the pending claim. The minter is the source of truth for the claim's
    /// recorded recipient/amount/nonce; it compares against `actualDeposit`
    /// and reverts if they actually match (no fraud) before slashing the bond.
    /// 25% of the slashed bond is paid out to `prover`.
    function vetoClaimWithProof(
        bytes32 claimNonce,
        BridgeMessage calldata actualDeposit,
        address prover
    ) external;
}
