// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title WarpFlatLinearFee
/// @notice Hyperlane warp-route token fee (`ITokenFee`) charging a flat
/// component plus a capped linear component, both denominated in the bridged
/// token:
///
///     fee = flatFee + min(maxLinearFee, amount * maxLinearFee / (2 * halfAmount))
///
/// The flat component exists so every message pays at least the destination
/// delivery gas the relayer fronts, which closes the dust-spam drain a purely
/// proportional fee leaves open (a proportional fee rounds to zero on tiny
/// amounts while the relayer still pays full gas on the other chain). All
/// parameters are immutable; the router owner can only repoint the router at a
/// different fee contract. The fee owner can only move accrued fees out
/// (`claim`) and never touches collateral, which the router holds separately.
contract WarpFlatLinearFee is Ownable {
    using SafeERC20 for IERC20;

    struct Quote {
        address token;
        uint256 amount;
    }

    /// @dev FeeType.LINEAR in @hyperlane-xyz/core BaseFee; the router does not
    /// read it, it is exposed for tooling parity.
    uint8 public constant FEE_TYPE = 1;

    IERC20 public immutable token;
    uint256 public immutable flatFee;
    uint256 public immutable maxLinearFee;
    uint256 public immutable halfAmount;

    error ZeroAddress();
    error ZeroHalfAmount();
    error NoFee();

    constructor(address token_, uint256 flatFee_, uint256 maxLinearFee_, uint256 halfAmount_, address owner_)
        Ownable(owner_)
    {
        if (token_ == address(0)) revert ZeroAddress();
        if (halfAmount_ == 0) revert ZeroHalfAmount();
        if (flatFee_ == 0 && maxLinearFee_ == 0) revert NoFee();
        token = IERC20(token_);
        flatFee = flatFee_;
        maxLinearFee = maxLinearFee_;
        halfAmount = halfAmount_;
    }

    /// @notice Quote the fee for a transfer. Destination/recipient are ignored:
    /// the contract is bound to a single router leg.
    function quoteTransferRemote(uint32, bytes32, uint256 amount) external view returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote(address(token), quoteFee(amount));
    }

    function quoteFee(uint256 amount) public view returns (uint256) {
        uint256 linear = (amount * maxLinearFee) / (2 * halfAmount);
        if (linear > maxLinearFee) linear = maxLinearFee;
        return flatFee + linear;
    }

    function feeType() external pure returns (uint8) {
        return FEE_TYPE;
    }

    /// @notice Sweep accrued fees to `beneficiary`.
    function claim(address beneficiary) external onlyOwner {
        if (beneficiary == address(0)) revert ZeroAddress();
        token.safeTransfer(beneficiary, token.balanceOf(address(this)));
    }
}
