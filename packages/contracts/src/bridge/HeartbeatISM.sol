// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IInterchainSecurityModule} from "./IInterchainSecurityModule.sol";

/// @notice Read-only view onto `BridgeMinter`'s heartbeat state used by
/// `HeartbeatISM`. Both fields are public storage variables on the minter so
/// the auto-generated getters match this signature.
interface IBridgeMinterHeartbeatView {
    function lastHeartbeatAt() external view returns (uint64);
    function heartbeatTimeoutSeconds() external view returns (uint64);
}

/// @title HeartbeatISM
/// @notice Defense-in-depth ISM that blocks inbound delivery while
/// `BridgeMinter`'s heartbeat is stale.
///
/// The minter already auto-pauses internal handlers after the heartbeat
/// timeout (see `BridgeMinter.checkHeartbeat()` from PR 8a); this ISM lifts
/// that posture into the Hyperlane delivery layer so even a relayer that
/// races the auto-pause is rejected at the mailbox boundary. Returning
/// `false` keeps the message pending and lets the operator re-deliver it
/// once the bot resumes heartbeats — no message is lost.
///
/// Stateless: no owner, no parameters, no mutable storage. The minter is
/// pinned at construction.
contract HeartbeatISM is IInterchainSecurityModule {
    /* -------------------------------------------------------------------- */
    /*                              IMMUTABLES                              */
    /* -------------------------------------------------------------------- */

    IBridgeMinterHeartbeatView public immutable minter;

    /* -------------------------------------------------------------------- */
    /*                                ERRORS                                */
    /* -------------------------------------------------------------------- */

    error HeartbeatISM_ZeroAddress();

    /* -------------------------------------------------------------------- */
    /*                              CONSTRUCTOR                             */
    /* -------------------------------------------------------------------- */

    constructor(IBridgeMinterHeartbeatView minter_) {
        if (address(minter_) == address(0)) revert HeartbeatISM_ZeroAddress();
        minter = minter_;
    }

    /* -------------------------------------------------------------------- */
    /*                                  ISM                                 */
    /* -------------------------------------------------------------------- */

    /// @inheritdoc IInterchainSecurityModule
    /// @dev `NULL = 6` per Hyperlane's `Types` enum — the right tag for
    ///      application-level ISMs that don't carry their own validator set.
    function moduleType() external pure returns (uint8) {
        return 6;
    }

    /// @inheritdoc IInterchainSecurityModule
    /// @dev Returns true iff `lastHeartbeatAt + heartbeatTimeoutSeconds >=
    ///      block.timestamp`. A `lastHeartbeatAt == 0` (never heartbeated)
    ///      always reads as stale and rejects.
    function verify(
        bytes calldata,
        /* _metadata */
        bytes calldata /* _message */
    )
        external
        view
        returns (bool)
    {
        return isFresh();
    }

    /// @notice Off-chain helper / human-readable accessor mirroring the
    /// freshness check used by `verify`.
    function isFresh() public view returns (bool) {
        uint64 last = minter.lastHeartbeatAt();
        if (last == 0) return false;
        uint64 timeout = minter.heartbeatTimeoutSeconds();
        unchecked {
            // last + timeout cannot overflow uint256; and we compare against
            // block.timestamp which fits in uint64 well past year 2106-relevant
            // contract horizons. Done in uint256 to avoid uint64 truncation.
            return uint256(last) + uint256(timeout) >= block.timestamp;
        }
    }
}
