// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BridgeMessage} from "./IBridgeMinter.sol";
import {IInterchainSecurityModule} from "./IInterchainSecurityModule.sol";

/// @notice Read-only view onto `BridgeMinter` used by `TVLCapISM`.
interface IBridgeMinterTvlView {
    function tvlCapEtx() external view returns (uint128);
    function wetx() external view returns (address);
}

/// @notice Minimal ERC20 surface (`totalSupply`) used to read live wETX
/// outstanding against the minter cap.
interface IERC20Supply {
    function totalSupply() external view returns (uint256);
}

/// @title TVLCapISM
/// @notice Defense-in-depth ISM that rejects an inbound mint that would push
/// `wETX.totalSupply()` past `BridgeMinter.tvlCapEtx()`. The same invariant is
/// re-checked inside `BridgeMinter.handle()` / `executeClaim`; lifting the
/// rejection up to the mailbox boundary leaves the message re-deliverable
/// once the cap is raised, instead of stranding it in `PENDING` state.
///
/// Stateless: no owner, no parameters, no mutable storage. Minter is pinned
/// at construction.
contract TVLCapISM is IInterchainSecurityModule {
    /* -------------------------------------------------------------------- */
    /*                              IMMUTABLES                              */
    /* -------------------------------------------------------------------- */

    IBridgeMinterTvlView public immutable minter;

    /* -------------------------------------------------------------------- */
    /*                                ERRORS                                */
    /* -------------------------------------------------------------------- */

    error TVLCapISM_ZeroAddress();

    /* -------------------------------------------------------------------- */
    /*                              CONSTRUCTOR                             */
    /* -------------------------------------------------------------------- */

    constructor(IBridgeMinterTvlView minter_) {
        if (address(minter_) == address(0)) revert TVLCapISM_ZeroAddress();
        minter = minter_;
    }

    /* -------------------------------------------------------------------- */
    /*                                  ISM                                 */
    /* -------------------------------------------------------------------- */

    /// @inheritdoc IInterchainSecurityModule
    function moduleType() external pure returns (uint8) {
        return 6;
    }

    /// @inheritdoc IInterchainSecurityModule
    /// @dev Hyperlane V3 message header is 77 bytes (1 version + 4 nonce
    ///      + 4 origin domain + 32 sender + 4 destination domain + 32
    ///      recipient). Our application body is `abi.encode(BridgeMessage)`,
    ///      which is exactly `32 * 8 = 256` bytes. Anything else — including
    ///      messages routed to a recipient that uses a different body shape
    ///      (e.g. the new `InsuranceTopUpReceiver` notice) — fails the
    ///      length check and is rejected. Deploy this ISM only on
    ///      `BridgeMinter` recipients.
    function verify(
        bytes calldata,
        /* _metadata */
        bytes calldata _message
    )
        external
        view
        returns (bool)
    {
        if (_message.length < 77 + 32 * 8) return false;
        bytes calldata body = _message[77:];
        if (body.length != 32 * 8) return false;

        BridgeMessage memory m = abi.decode(body, (BridgeMessage));
        return wouldFit(m.amount);
    }

    /// @notice Off-chain accessor: would minting `amount` more wETX still
    /// keep `totalSupply <= tvlCapEtx`?
    function wouldFit(uint128 amount) public view returns (bool) {
        uint256 supply = IERC20Supply(minter.wetx()).totalSupply();
        uint256 cap = uint256(minter.tvlCapEtx());
        return supply + uint256(amount) <= cap;
    }
}
