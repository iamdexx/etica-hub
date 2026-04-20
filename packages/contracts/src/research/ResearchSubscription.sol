// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ResearchSubscription
/// @notice Simple per-address expiry registry. Subscribers pay ETI for N
///         months of access; the full payment is forwarded to the treasury
///         (no protocol-held float, no slashing risk). Expiry is stored and
///         emitted; the frontend / API gates content off of `expiresAt(user)`.
///
/// @dev    Keeps accounting pure: no time-weighted refunds, no partial months.
///         Off-chain consumers should treat a subscription as "valid iff
///         `expiresAt(user) > block.timestamp`".
contract ResearchSubscription is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_MONTHS = 24;
    uint256 public constant SECONDS_PER_MONTH = 30 days;

    IERC20 public immutable eti;
    address public treasury;

    /// @notice ETI cost for one month of access. Owner-configurable.
    uint256 public pricePerMonth;

    /// @notice Unix timestamp at which a subscriber's access expires.
    mapping(address => uint256) public expiresAt;

    event Subscribed(address indexed subscriber, uint256 months_, uint256 paid, uint256 newExpiry);
    event PriceUpdated(uint256 oldPrice, uint256 newPrice);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    error ZeroAddress();
    error ZeroMonths();
    error MonthsTooLarge();
    error PriceNotSet();

    constructor(IERC20 _eti, address _treasury, uint256 _pricePerMonth, address _owner)
        Ownable(_owner)
    {
        if (address(_eti) == address(0) || _treasury == address(0) || _owner == address(0)) {
            revert ZeroAddress();
        }
        eti = _eti;
        treasury = _treasury;
        pricePerMonth = _pricePerMonth;
    }

    /// @notice Pay for `months_` of access. ETI is pulled from msg.sender and
    ///         forwarded to the treasury. Extends `expiresAt[msg.sender]` from
    ///         whichever is later: now or its current value.
    function subscribe(uint256 months_) external nonReentrant {
        if (months_ == 0) revert ZeroMonths();
        if (months_ > MAX_MONTHS) revert MonthsTooLarge();

        uint256 price = pricePerMonth;
        if (price == 0) revert PriceNotSet();

        uint256 paid = price * months_;
        eti.safeTransferFrom(msg.sender, treasury, paid);

        uint256 current = expiresAt[msg.sender];
        uint256 start = current > block.timestamp ? current : block.timestamp;
        uint256 newExpiry = start + months_ * SECONDS_PER_MONTH;
        expiresAt[msg.sender] = newExpiry;

        emit Subscribed(msg.sender, months_, paid, newExpiry);
    }

    /// @notice True if `user` has unexpired access.
    function isActive(address user) external view returns (bool) {
        return expiresAt[user] > block.timestamp;
    }

    function setPricePerMonth(uint256 newPrice) external onlyOwner {
        emit PriceUpdated(pricePerMonth, newPrice);
        pricePerMonth = newPrice;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }
}
