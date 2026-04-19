// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Pluggable verifier for cross-chain attestations. The MVP
/// implementation is `MultisigVerifier` (M-of-N ECDSA). The interface exists
/// so a future light-client or zk verifier can replace it without touching
/// the vault / minter storage layout.
interface IAttestationVerifier {
    /// @notice Verify that `signatures` constitutes a valid attestation for
    /// `digest`. Reverts on failure; returns normally on success.
    /// @dev Implementations MUST NOT allow the same signer to be counted
    /// twice. Duplicate signers MUST cause a revert even if the underlying
    /// signatures are individually valid.
    function verify(bytes32 digest, bytes[] calldata signatures) external view;
}
