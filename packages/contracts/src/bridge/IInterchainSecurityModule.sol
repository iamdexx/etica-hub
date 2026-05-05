// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Hyperlane V3 ISM surface. Mailbox calls `verify` once per inbound
/// `process(...)`; returning `false` (or reverting) reverts the entire
/// delivery atomically — including any state changes made by this ISM, the
/// mailbox's `delivered[id]` write, and the recipient's `handle()`.
///
/// `moduleType` is informational; we use the Hyperlane convention `NULL = 6`
/// for application-level custom ISMs that don't fit a built-in category.
interface IInterchainSecurityModule {
    function moduleType() external view returns (uint8);
    function verify(bytes calldata _metadata, bytes calldata _message) external returns (bool);
}

/// @notice Optional companion interface a recipient implements to point the
/// mailbox at a specific ISM. We don't wire this on `BridgeMinter` in this PR
/// (kept scoped to the ISM contracts themselves); the deploy/ops PR will set
/// it once the address layout is finalised.
interface ISpecifiesInterchainSecurityModule {
    function interchainSecurityModule() external view returns (IInterchainSecurityModule);
}
