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

/// @notice Minimal cross-contract surface that `OptimisticVetoModule` and
/// `FraudProverModule` rely on. The full `BridgeMinter` is implemented in a
/// later impl PR; this interface is sized to the calls those modules make.
interface IBridgeMinter {
    function vetoClaimManual(bytes32 nonce, VetoReason reason) external;
}
