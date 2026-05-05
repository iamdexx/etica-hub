// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IHyperlane
/// @notice Single source of truth for the minimal Hyperlane V3 surface used by
/// the Phase 3 bridge stack. Mirrors the canonical signatures from
/// `@hyperlane-xyz/core` so the bridge can swap to the audited stdlib without
/// touching call sites — every importer references the same interface symbol.
///
/// The bridge intentionally pins the **minimum** surface needed by its own
/// flows. Specifically, Hyperlane V3 ships richer overloads for `dispatch`
/// (custom hooks + metadata) and a `handle` recipient hook; the bridge only
/// uses the simplest pair. Documenting the V3 overloads as commented-out
/// signatures so future upgrades to hook-aware dispatch are obvious diffs.

/// @notice Hyperlane mailbox dispatch surface.
/// @dev Matches `@hyperlane-xyz/core/contracts/interfaces/IMailbox.sol`.
interface IMailbox {
    /// @notice Send a message to a destination domain.
    /// @param destinationDomain Hyperlane domain ID of the destination chain.
    /// @param recipientAddress  Recipient address on the destination chain,
    ///                          left-zero-padded into a `bytes32`.
    /// @param messageBody       Application payload.
    /// @return messageId        Hyperlane message ID (keccak256 of message).
    function dispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata messageBody
    ) external payable returns (bytes32 messageId);

    // ------------------------------------------------------------------------
    // V3 surface (not yet used by the bridge; documented so an upgrade is a
    // mechanical diff). Uncomment when the bridge wires custom hooks/metadata.
    //
    // function dispatch(
    //     uint32 destinationDomain,
    //     bytes32 recipientAddress,
    //     bytes calldata messageBody,
    //     bytes calldata defaultHookMetadata
    // ) external payable returns (bytes32 messageId);
    //
    // function dispatch(
    //     uint32 destinationDomain,
    //     bytes32 recipientAddress,
    //     bytes calldata messageBody,
    //     bytes calldata customHookMetadata,
    //     address customHook
    // ) external payable returns (bytes32 messageId);
    //
    // function quoteDispatch(
    //     uint32 destinationDomain,
    //     bytes32 recipientAddress,
    //     bytes calldata messageBody
    // ) external view returns (uint256 fee);
    //
    // function localDomain() external view returns (uint32);
}

/// @notice Hyperlane message recipient hook.
/// @dev Matches `@hyperlane-xyz/core/contracts/interfaces/IMessageRecipient.sol`.
///      The bridge's `BridgeMinter`, `BridgeVault`, and `InsuranceTopUpReceiver`
///      all expose a `handle(...)` function with this exact signature; this
///      interface exists for reference and for future external integrations
///      (e.g., compile-time `is IMessageRecipient` declarations).
interface IMessageRecipient {
    function handle(uint32 origin, bytes32 sender, bytes calldata message) external payable;
}
