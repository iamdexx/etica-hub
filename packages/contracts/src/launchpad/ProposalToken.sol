// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title ProposalToken
/// @notice Fixed-supply ERC-20 launched by a research proposal author via
///         {ProposalTokenFactory}. Total supply is minted once at construction
///         to the factory, which then splits it into LP / liquid-author /
///         vested-author according to the factory's constants and redistributes.
///
///         There is no mint, burn-from-any, pause, owner, or upgrade. Supply
///         is permanent and fully transferable from day 1. The factory simply
///         seeds the initial `ProposalToken/ETX` pool and author distribution.
///
/// @dev    Each research proposal gets at most one ProposalToken. Enforcement
///         lives in {ProposalTokenFactory}. Permit is supported for gasless
///         approvals against the swap router.
contract ProposalToken is ERC20Permit {
    /// @notice The proposal this token was launched for (release hash from
    ///         the Etica core contract).
    bytes32 public immutable proposalHash;

    /// @notice The wallet that authored the proposal and launched this token.
    address public immutable proposer;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        bytes32 proposalHash_,
        address proposer_,
        address mintTo
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        require(totalSupply_ > 0, "PT: zero supply");
        require(proposer_ != address(0), "PT: zero proposer");
        require(mintTo != address(0), "PT: zero mintTo");
        proposalHash = proposalHash_;
        proposer = proposer_;
        _mint(mintTo, totalSupply_);
    }
}
