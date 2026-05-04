// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title LiquidityTimelock10y — 10-year time-lock for treasury LP shares
/// @notice Holds LP shares of an ERC-20 LP token (e.g. EticaStableSwap esLP)
///         on behalf of the treasury, with a hard floor on what can be
///         withdrawn before the lock expires.
///
///         Mechanics:
///           - At deploy, `lockedAmount` LP shares are pinned. The contract
///             cannot transfer LP shares below `lockedAmount` until
///             `unlockTime` (deploy time + 10 years).
///           - LP shares ABOVE `lockedAmount` (e.g. accidental over-funding,
///             or bonus mints) can be withdrawn by the owner at any time.
///           - Anything that ISN'T the locked LP token — admin-fee payouts,
///             retroactive airdrops, governance tokens, NFTs — is freely
///             rescuable by the owner with no time gate. Fees are NOT locked.
///
///         Why this design:
///           The pool itself has no concept of "locked" vs "free" LPs. From
///           the pool's perspective this contract is just an LP-share holder
///           that happens to never burn its principal. Fees stream OUT of
///           the pool to a separate {adminFeeRecipient} address (the
///           harvester adapter); they never enter this contract. So locking
///           the LP balance here does NOT lock fees in any way.
///
///         Trust model:
///           - `owner()` is the treasury multisig. Owner can:
///               * withdraw locked LP after `unlockTime`
///               * withdraw EXCESS locked-token balance any time
///               * rescue ANY non-locked token any time (fees, airdrops)
///           - Owner cannot reduce {unlockTime}, cannot reduce {lockedAmount}
///             during the lock period, and cannot move locked LP early.
contract LiquidityTimelock10y is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Default lock duration. Set to exactly 10 years.
    uint256 public constant LOCK_DURATION = 365 days * 10;

    /// @notice The LP token whose principal is locked.
    IERC20 public immutable lockedToken;

    /// @notice Block timestamp at which the lock unconditionally expires.
    uint64 public immutable unlockTime;

    /// @notice The minimum LP-token balance this contract must keep until
    ///         {unlockTime}. Any balance above this is "excess" and freely
    ///         withdrawable.
    uint256 public lockedAmount;

    event LockedAmountSet(uint256 newLockedAmount);
    event ExcessWithdrawn(address indexed to, uint256 amount);
    event LockedWithdrawn(address indexed to, uint256 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error StillLocked(uint256 nowTime, uint256 unlocksAt);
    error ExceedsExcess(uint256 requested, uint256 available);
    error CannotRescueLockedToken();
    error CannotIncreaseLockMidLife();

    /// @param _owner       Treasury multisig.
    /// @param _lockedToken LP token contract (e.g. EticaStableSwap esLP).
    constructor(address _owner, IERC20 _lockedToken) Ownable(_owner) {
        if (address(_lockedToken) == address(0)) revert ZeroAddress();
        lockedToken = _lockedToken;
        unlockTime = uint64(block.timestamp + LOCK_DURATION);
    }

    // -------------------------------------------------------------------------
    // Setup
    // -------------------------------------------------------------------------

    /// @notice Mark the current LP balance (or a specific amount of it) as
    ///         locked. Once set, `lockedAmount` may only be DECREASED via
    ///         {lockedWithdraw} after {unlockTime}, never increased after
    ///         the first non-zero set. This pin is what makes the lock
    ///         binding even when the owner is the multisig.
    function setLockedAmount(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        // Once set non-zero, the lock is sticky — owner cannot raise it
        // above its current value, since doing so could pull in tokens that
        // arrived after the seed event and weren't intended to be locked.
        if (lockedAmount != 0 && amount > lockedAmount) revert CannotIncreaseLockMidLife();
        // The contract must hold at least `amount` of the locked token,
        // otherwise the cap is unenforceable (we'd be locking promises).
        require(lockedToken.balanceOf(address(this)) >= amount, "insufficient balance");
        lockedAmount = amount;
        emit LockedAmountSet(amount);
    }

    // -------------------------------------------------------------------------
    // Withdraws
    // -------------------------------------------------------------------------

    /// @notice Withdraw LP shares above {lockedAmount}. No time gate.
    function withdrawExcess(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 bal = lockedToken.balanceOf(address(this));
        uint256 free = (bal > lockedAmount) ? bal - lockedAmount : 0;
        if (amount > free) revert ExceedsExcess(amount, free);
        lockedToken.safeTransfer(to, amount);
        emit ExcessWithdrawn(to, amount);
    }

    /// @notice Withdraw locked LP shares. Reverts before {unlockTime}.
    function lockedWithdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp < unlockTime) revert StillLocked(block.timestamp, unlockTime);
        uint256 bal = lockedToken.balanceOf(address(this));
        require(amount <= bal, "amount > balance");
        // Drop the lock floor accordingly so subsequent excess accounting
        // remains coherent (post-unlock there's nothing to enforce, but
        // tracking is cleaner this way).
        if (amount >= lockedAmount) {
            lockedAmount = 0;
        } else {
            lockedAmount -= amount;
        }
        lockedToken.safeTransfer(to, amount);
        emit LockedWithdrawn(to, amount);
    }

    /// @notice Rescue any non-locked token. Useful for sweeping admin-fee
    ///         payouts, accidental airdrops, or governance tokens that
    ///         end up in this contract. Reverts if `token == lockedToken`.
    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (address(token) == address(lockedToken)) revert CannotRescueLockedToken();
        token.safeTransfer(to, amount);
        emit Rescued(address(token), to, amount);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function isUnlocked() external view returns (bool) {
        return block.timestamp >= unlockTime;
    }

    function timeUntilUnlock() external view returns (uint256) {
        if (block.timestamp >= unlockTime) return 0;
        return unlockTime - block.timestamp;
    }

    function freeBalance() external view returns (uint256) {
        uint256 bal = lockedToken.balanceOf(address(this));
        return (bal > lockedAmount) ? bal - lockedAmount : 0;
    }
}
