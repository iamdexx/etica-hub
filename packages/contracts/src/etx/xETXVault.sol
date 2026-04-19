// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title xETX staking vault
/// @notice Stake ETX to earn a pro-rata share of ETI rewards funneled here by
///         the FeeRouter. Classic SNX-style staking (Synthetix StakingRewards),
///         with a 7-day cooldown on unstake.
/// @dev    stakingToken = ETX, rewardToken = ETI. The distributor (FeeRouter)
///         calls `notifyRewardAmount` after depositing ETI into the vault to
///         start a new 7-day reward period.
contract xETXVault is ERC20, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    IERC20 public immutable stakingToken;
    IERC20 public immutable rewardToken;

    address public distributor;
    uint256 public rewardsDuration = 7 days;
    uint256 public cooldownDuration = 7 days;

    uint256 public periodFinish;
    uint256 public rewardRate;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    struct UnstakeRequest {
        uint128 amount;
        uint64 availableAt;
    }

    mapping(address => UnstakeRequest) public unstakeRequests;

    event Staked(address indexed user, uint256 amount);
    event UnstakeRequested(address indexed user, uint256 amount, uint64 availableAt);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(uint256 amount, uint256 periodFinish);
    event DistributorUpdated(address distributor);
    event RewardsDurationUpdated(uint256 duration);
    event CooldownDurationUpdated(uint256 duration);

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    modifier onlyDistributor() {
        require(msg.sender == distributor, "xETX: not distributor");
        _;
    }

    constructor(IERC20 _stakingToken, IERC20 _rewardToken, address _owner)
        ERC20("Staked ETX", "xETX")
        Ownable(_owner)
    {
        require(address(_stakingToken) != address(0), "xETX: zero stake");
        require(address(_rewardToken) != address(0), "xETX: zero reward");
        stakingToken = _stakingToken;
        rewardToken = _rewardToken;
    }

    function setDistributor(address _distributor) external onlyOwner {
        distributor = _distributor;
        emit DistributorUpdated(_distributor);
    }

    function setRewardsDuration(uint256 _duration) external onlyOwner {
        require(block.timestamp >= periodFinish, "xETX: period not done");
        require(_duration > 0, "xETX: zero duration");
        rewardsDuration = _duration;
        emit RewardsDurationUpdated(_duration);
    }

    function setCooldownDuration(uint256 _duration) external onlyOwner {
        require(_duration <= 30 days, "xETX: cooldown too long");
        cooldownDuration = _duration;
        emit CooldownDurationUpdated(_duration);
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return rewardPerTokenStored;
        return rewardPerTokenStored
            + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18) / supply;
    }

    function earned(address account) public view returns (uint256) {
        return (balanceOf(account) * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18
            + rewards[account];
    }

    function stake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "xETX: zero stake");
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
        emit Staked(msg.sender, amount);
    }

    function requestUnstake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "xETX: zero unstake");
        require(balanceOf(msg.sender) >= amount, "xETX: insufficient xETX");
        _burn(msg.sender, amount);
        uint256 existing = unstakeRequests[msg.sender].amount;
        uint64 availableAt = (block.timestamp + cooldownDuration).toUint64();
        unstakeRequests[msg.sender] =
            UnstakeRequest({amount: (existing + amount).toUint128(), availableAt: availableAt});
        emit UnstakeRequested(msg.sender, amount, availableAt);
    }

    function withdraw() external nonReentrant {
        UnstakeRequest memory req = unstakeRequests[msg.sender];
        require(req.amount > 0, "xETX: no request");
        require(block.timestamp >= req.availableAt, "xETX: cooldown active");
        delete unstakeRequests[msg.sender];
        stakingToken.safeTransfer(msg.sender, req.amount);
        emit Withdrawn(msg.sender, req.amount);
    }

    function claimReward() external nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    /// @notice Called by the FeeRouter after depositing `amount` of reward token
    ///         into this vault. Extends or starts a new reward period.
    function notifyRewardAmount(uint256 amount) external onlyDistributor updateReward(address(0)) {
        if (block.timestamp >= periodFinish) {
            rewardRate = amount / rewardsDuration;
        } else {
            uint256 remaining = periodFinish - block.timestamp;
            uint256 leftover = remaining * rewardRate;
            rewardRate = (amount + leftover) / rewardsDuration;
        }

        uint256 balance = rewardToken.balanceOf(address(this));
        require(rewardRate <= balance / rewardsDuration, "xETX: reward > balance");

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
        emit RewardAdded(amount, periodFinish);
    }

    // xETX is non-transferable — enforcing "staked" semantics keeps the
    // cooldown meaningful. Mint/burn from stake/unstake still works because
    // those paths use address(0).
    function _update(address from, address to, uint256 value) internal override {
        require(from == address(0) || to == address(0), "xETX: non-transferable");
        super._update(from, to, value);
    }
}
