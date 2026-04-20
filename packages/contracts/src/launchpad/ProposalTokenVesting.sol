// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ProposalTokenVesting
/// @notice Linear vesting schedule for one proposal author. The factory
///         deploys one of these per launched proposal token, transfers the
///         author's vested allocation in, and sets the author as the only
///         beneficiary.
///
///         Tokens unlock linearly over `duration` starting at `start`, with
///         no cliff. `release()` is permissionless but can only push funds
///         to the immutable beneficiary.
///
/// @dev    Keeps accounting minimal: `released` tracks how much has been
///         withdrawn, `vestedAt(ts)` is `totalAmount * elapsed / duration`.
///         After `start + duration`, 100% is claimable.
contract ProposalTokenVesting {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable beneficiary;
    uint64 public immutable start;
    uint64 public immutable duration;
    uint256 public immutable totalAmount;

    uint256 public released;

    event Released(uint256 amount);

    constructor(
        IERC20 token_,
        address beneficiary_,
        uint64 start_,
        uint64 duration_,
        uint256 totalAmount_
    ) {
        require(address(token_) != address(0), "PTV: zero token");
        require(beneficiary_ != address(0), "PTV: zero beneficiary");
        require(duration_ > 0, "PTV: zero duration");
        require(totalAmount_ > 0, "PTV: zero total");
        token = token_;
        beneficiary = beneficiary_;
        start = start_;
        duration = duration_;
        totalAmount = totalAmount_;
    }

    /// @notice Amount vested at `timestamp` (including already-released).
    function vestedAt(uint64 timestamp) public view returns (uint256) {
        if (timestamp < start) return 0;
        uint256 elapsed = uint256(timestamp) - uint256(start);
        if (elapsed >= duration) return totalAmount;
        return (totalAmount * elapsed) / duration;
    }

    /// @notice Amount currently claimable by the beneficiary.
    function releasable() public view returns (uint256) {
        return vestedAt(uint64(block.timestamp)) - released;
    }

    /// @notice Release all currently-vested tokens to the beneficiary.
    function release() external returns (uint256 amount) {
        amount = releasable();
        if (amount == 0) return 0;
        released += amount;
        token.safeTransfer(beneficiary, amount);
        emit Released(amount);
    }
}
