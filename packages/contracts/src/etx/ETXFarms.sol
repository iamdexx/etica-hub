// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  ETXFarms
/// @notice LP-stake farming contract for EticaHub. Receives ETX rewards via
///         {distributeRewards} (called by the TreasuryHarvester on each
///         harvest cycle) and credits them pro-rata across staked LP pools.
///
///         Design:
///           - No emissions. The contract only distributes ETX that was
///             explicitly transferred in via {distributeRewards}. If no
///             rewards arrive, stakers earn nothing but lose nothing either.
///           - MasterChef-style accumulator math (`accRewardPerShare`), the
///             industry-standard LP-farm pattern with the simplest proofs.
///           - Per-pool allocation weights configurable by owner. Dust from
///             integer division accrues to the last pool.
///           - Pools with zero staked LP at the moment rewards arrive do not
///             dilute the live pools: their share is forwarded to a
///             fallback recipient (treasury) so nothing sits idle.
///
///         Trust model:
///           - `owner()` can add pools, change allocation weights, and
///             rotate the fallback recipient. Owner CANNOT pause the
///             contract, CANNOT rescue staked LP, and CANNOT rescue the
///             reward asset (ETX) — any ETX in the contract belongs to
///             stakers pro-rata via the accumulator.
///           - {distributeRewards} is PERMISSIONLESS. Anyone can push ETX
///             to the accumulator. In practice only the TreasuryHarvester
///             will, but there is no griefing vector — pushing rewards
///             only benefits existing stakers.
///           - Users can `emergencyWithdraw` their LP at any time,
///             forfeiting pending rewards. No timelock, no freeze path.
contract ETXFarms is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Fixed-point scalar for `accRewardPerShare`.
    uint256 public constant ACC_PRECISION = 1e18;

    /// @notice The reward token (ETX).
    address public immutable rewardToken;

    /// @notice Fallback recipient for rewards allocated to a pool with zero
    ///         staked LP. Defaults to owner at deployment; rotatable to the
    ///         treasury or a burn sink.
    address public fallbackRecipient;

    struct PoolInfo {
        /// @dev The staked LP token. For EticaHub this is the ETI/ETX or
        ///      EGAZ/ETX EticaSwap pair, but any ERC-20 is accepted.
        IERC20 lpToken;
        /// @dev Pool allocation weight, proportional to other pools.
        uint256 allocPoint;
        /// @dev Total LP currently staked in this pool.
        uint256 totalStaked;
        /// @dev Accumulated ETX reward per staked LP (scaled by ACC_PRECISION).
        uint256 accRewardPerShare;
    }

    struct UserInfo {
        /// @dev Staked LP balance for this pool.
        uint256 amount;
        /// @dev Reward debt; see MasterChef accumulator pattern.
        uint256 rewardDebt;
    }

    /// @notice All configured pools. Pool id (`pid`) is the array index.
    PoolInfo[] public poolInfo;

    /// @notice Sum of all `poolInfo[i].allocPoint`. Updated whenever an
    ///         allocation weight changes.
    uint256 public totalAllocPoint;

    /// @notice Per-pool-per-user bookkeeping. `userInfo[pid][user]`.
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;

    /// @notice Convenience set: the LP token addresses registered as pools.
    ///         Used by the rescue guard to prevent the owner from
    ///         transferring staked LP.
    mapping(address => bool) public isLpToken;

    event PoolAdded(uint256 indexed pid, address indexed lpToken, uint256 allocPoint);
    event PoolAllocUpdated(uint256 indexed pid, uint256 oldAlloc, uint256 newAlloc);
    event FallbackRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event RewardsDistributed(address indexed from, uint256 amount);
    event Deposit(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event Harvest(address indexed user, uint256 indexed pid, uint256 amount);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event FallbackForwarded(uint256 indexed pid, uint256 amount);
    event Rescue(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidPid();
    error LpAlreadyRegistered();
    error CannotRescueRewardToken();
    error CannotRescueStakedLp();
    error NoActivePools();
    error InsufficientStake();

    /// @param _rewardToken       The ETX token address; rewards are denominated
    ///                           here and only here.
    /// @param _fallbackRecipient Receiver of rewards allocated to empty pools.
    ///                           MUST NOT be the zero address.
    /// @param _owner             Initial owner. Can manage pools + allocation.
    constructor(address _rewardToken, address _fallbackRecipient, address _owner)
        Ownable(_owner == address(0) ? msg.sender : _owner)
    {
        if (_rewardToken == address(0)) revert ZeroAddress();
        if (_fallbackRecipient == address(0)) revert ZeroAddress();
        rewardToken = _rewardToken;
        fallbackRecipient = _fallbackRecipient;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Number of pools registered.
    function poolLength() external view returns (uint256) {
        return poolInfo.length;
    }

    /// @notice Pending ETX rewards claimable by `user` in `pid`.
    function pendingReward(uint256 pid, address user) external view returns (uint256) {
        if (pid >= poolInfo.length) revert InvalidPid();
        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage u = userInfo[pid][user];
        if (u.amount == 0) return 0;
        uint256 accrued = (u.amount * pool.accRewardPerShare) / ACC_PRECISION;
        return accrued - u.rewardDebt;
    }

    // -------------------------------------------------------------------------
    // Owner management
    // -------------------------------------------------------------------------

    /// @notice Register a new LP pool. Each LP token can only be added once.
    function addPool(IERC20 lpToken, uint256 allocPoint) external onlyOwner {
        if (address(lpToken) == address(0)) revert ZeroAddress();
        if (address(lpToken) == rewardToken) revert CannotRescueStakedLp(); // conservative: forbid farming ETX itself
        if (isLpToken[address(lpToken)]) revert LpAlreadyRegistered();

        isLpToken[address(lpToken)] = true;
        poolInfo.push(
            PoolInfo({
                lpToken: lpToken,
                allocPoint: allocPoint,
                totalStaked: 0,
                accRewardPerShare: 0
            })
        );
        totalAllocPoint += allocPoint;
        emit PoolAdded(poolInfo.length - 1, address(lpToken), allocPoint);
    }

    /// @notice Update a pool's allocation weight. Affects future {distributeRewards}
    ///         calls only; existing `accRewardPerShare` is untouched, so
    ///         nobody's accrued rewards change retroactively.
    function setAllocPoint(uint256 pid, uint256 newAllocPoint) external onlyOwner {
        if (pid >= poolInfo.length) revert InvalidPid();
        PoolInfo storage pool = poolInfo[pid];
        uint256 old = pool.allocPoint;
        totalAllocPoint = totalAllocPoint - old + newAllocPoint;
        pool.allocPoint = newAllocPoint;
        emit PoolAllocUpdated(pid, old, newAllocPoint);
    }

    /// @notice Rotate the fallback recipient for empty-pool reward shares.
    function setFallbackRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FallbackRecipientUpdated(fallbackRecipient, newRecipient);
        fallbackRecipient = newRecipient;
    }

    /// @notice Rescue an ERC-20 accidentally sent to this contract. Cannot
    ///         be used for ETX (belongs to stakers pro-rata) or for any
    ///         staked LP token (belongs to stakers directly).
    function rescueToken(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (address(token) == rewardToken) revert CannotRescueRewardToken();
        if (isLpToken[address(token)]) revert CannotRescueStakedLp();
        token.safeTransfer(to, amount);
        emit Rescue(address(token), to, amount);
    }

    // -------------------------------------------------------------------------
    // Reward injection (harvester calls this)
    // -------------------------------------------------------------------------

    /// @notice Push `amount` of ETX into the farm accumulator. Caller must
    ///         have previously approved at least `amount` on the ETX token.
    ///         Reverts if there are no pools or total allocation is zero.
    ///
    /// @dev    Pools with zero staked LP at call time do not accrue; their
    ///         share is forwarded to `fallbackRecipient` so no reward sits
    ///         idle. This also prevents a "first depositor claims all past
    ///         rewards" race, because the accumulator only rises when
    ///         someone is already staked.
    function distributeRewards(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 len = poolInfo.length;
        if (len == 0 || totalAllocPoint == 0) revert NoActivePools();

        // Pull the full amount up-front; anything undistributable flows to
        // the fallback recipient below.
        IERC20(rewardToken).safeTransferFrom(msg.sender, address(this), amount);
        emit RewardsDistributed(msg.sender, amount);

        uint256 totalAlloc = totalAllocPoint;
        uint256 distributed;
        uint256 idleForwarded;

        // Walk every pool except the last; the last pool absorbs dust from
        // integer division.
        for (uint256 i = 0; i < len; i++) {
            PoolInfo storage pool = poolInfo[i];
            uint256 share;
            if (i == len - 1) {
                // Residual — guarantees sum(share_i) == amount exactly.
                share = amount - distributed;
            } else {
                share = (amount * pool.allocPoint) / totalAlloc;
                distributed += share;
            }

            if (share == 0) continue;

            if (pool.totalStaked == 0) {
                idleForwarded += share;
                emit FallbackForwarded(i, share);
            } else {
                // accRewardPerShare += share * PRECISION / totalStaked
                pool.accRewardPerShare += (share * ACC_PRECISION) / pool.totalStaked;
            }
        }

        if (idleForwarded > 0) {
            IERC20(rewardToken).safeTransfer(fallbackRecipient, idleForwarded);
        }
    }

    // -------------------------------------------------------------------------
    // User actions
    // -------------------------------------------------------------------------

    /// @notice Stake `amount` LP into pool `pid`. Automatically harvests any
    ///         pending rewards as part of the deposit.
    function deposit(uint256 pid, uint256 amount) external nonReentrant {
        if (pid >= poolInfo.length) revert InvalidPid();
        if (amount == 0) revert ZeroAmount();
        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage u = userInfo[pid][msg.sender];

        // Harvest any pending before mutating the user's position.
        if (u.amount > 0) {
            uint256 pending = (u.amount * pool.accRewardPerShare) / ACC_PRECISION - u.rewardDebt;
            if (pending > 0) {
                _payReward(msg.sender, pid, pending);
            }
        }

        pool.lpToken.safeTransferFrom(msg.sender, address(this), amount);
        u.amount += amount;
        pool.totalStaked += amount;
        u.rewardDebt = (u.amount * pool.accRewardPerShare) / ACC_PRECISION;

        emit Deposit(msg.sender, pid, amount);
    }

    /// @notice Unstake `amount` LP from pool `pid`. Automatically harvests
    ///         any pending rewards as part of the withdrawal.
    function withdraw(uint256 pid, uint256 amount) external nonReentrant {
        if (pid >= poolInfo.length) revert InvalidPid();
        if (amount == 0) revert ZeroAmount();
        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage u = userInfo[pid][msg.sender];
        if (u.amount < amount) revert InsufficientStake();

        uint256 pending = (u.amount * pool.accRewardPerShare) / ACC_PRECISION - u.rewardDebt;
        if (pending > 0) {
            _payReward(msg.sender, pid, pending);
        }

        u.amount -= amount;
        pool.totalStaked -= amount;
        u.rewardDebt = (u.amount * pool.accRewardPerShare) / ACC_PRECISION;

        pool.lpToken.safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, pid, amount);
    }

    /// @notice Claim pending rewards for pool `pid` without changing the
    ///         staked balance.
    function harvest(uint256 pid) external nonReentrant {
        if (pid >= poolInfo.length) revert InvalidPid();
        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage u = userInfo[pid][msg.sender];
        if (u.amount == 0) return;

        uint256 pending = (u.amount * pool.accRewardPerShare) / ACC_PRECISION - u.rewardDebt;
        if (pending > 0) {
            _payReward(msg.sender, pid, pending);
            u.rewardDebt = (u.amount * pool.accRewardPerShare) / ACC_PRECISION;
        }
    }

    /// @notice Exit a pool, forfeiting any pending rewards. For use if the
    ///         accumulator math is ever in doubt; the user always recovers
    ///         their staked LP.
    function emergencyWithdraw(uint256 pid) external nonReentrant {
        if (pid >= poolInfo.length) revert InvalidPid();
        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage u = userInfo[pid][msg.sender];
        uint256 amount = u.amount;
        if (amount == 0) return;

        u.amount = 0;
        u.rewardDebt = 0;
        pool.totalStaked -= amount;
        pool.lpToken.safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, pid, amount);
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _payReward(address to, uint256 pid, uint256 amount) internal {
        // Guard against rounding overshoot.
        uint256 bal = IERC20(rewardToken).balanceOf(address(this));
        uint256 payable_ = amount > bal ? bal : amount;
        if (payable_ == 0) return;
        IERC20(rewardToken).safeTransfer(to, payable_);
        emit Harvest(to, pid, payable_);
    }
}
