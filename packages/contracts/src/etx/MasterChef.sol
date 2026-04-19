// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title EticaHub MasterChef
/// @notice Sushi-style LP staking with ETX emissions. Intended to be pre-funded
///         with the 70M ETX emissions allocation at deploy. Rewards are paid
///         from MasterChef's own ETX balance and stop naturally once depleted.
/// @dev Admin adds ETI-paired pools only (gated off-chain / at deploy). The
///      contract itself is pool-agnostic for upgradeability, but the deploy
///      script only wires ETI-paired LP tokens.
contract MasterChef is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct UserInfo {
        uint256 amount; // LP staked
        uint256 rewardDebt; // bookkeeping
    }

    struct PoolInfo {
        IERC20 lpToken;
        uint256 allocPoint;
        uint64 lastRewardTime;
        uint256 accEtxPerShare; // scaled by 1e12
    }

    uint256 public constant PRECISION = 1e12;

    IERC20 public immutable etx;
    uint256 public etxPerSecond;
    uint64 public startTime;
    uint256 public totalAllocPoint;

    PoolInfo[] public poolInfo;
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;
    mapping(address => bool) public lpAdded;

    event PoolAdded(uint256 indexed pid, address indexed lpToken, uint256 allocPoint);
    event PoolUpdated(uint256 indexed pid, uint256 allocPoint);
    event Deposit(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event EmissionRateUpdated(uint256 etxPerSecond);
    event Harvest(address indexed user, uint256 indexed pid, uint256 amount);

    constructor(IERC20 _etx, uint256 _etxPerSecond, uint64 _startTime, address _owner)
        Ownable(_owner)
    {
        require(address(_etx) != address(0), "MC: zero etx");
        require(_owner != address(0), "MC: zero owner");
        etx = _etx;
        etxPerSecond = _etxPerSecond;
        startTime = _startTime;
    }

    function poolLength() external view returns (uint256) {
        return poolInfo.length;
    }

    function add(uint256 _allocPoint, IERC20 _lpToken) external onlyOwner {
        require(!lpAdded[address(_lpToken)], "MC: lp exists");
        massUpdatePools();
        uint64 last = uint64(block.timestamp > startTime ? block.timestamp : startTime);
        totalAllocPoint += _allocPoint;
        poolInfo.push(
            PoolInfo({
                lpToken: _lpToken, allocPoint: _allocPoint, lastRewardTime: last, accEtxPerShare: 0
            })
        );
        lpAdded[address(_lpToken)] = true;
        emit PoolAdded(poolInfo.length - 1, address(_lpToken), _allocPoint);
    }

    function set(uint256 _pid, uint256 _allocPoint) external onlyOwner {
        massUpdatePools();
        totalAllocPoint = totalAllocPoint - poolInfo[_pid].allocPoint + _allocPoint;
        poolInfo[_pid].allocPoint = _allocPoint;
        emit PoolUpdated(_pid, _allocPoint);
    }

    function setEtxPerSecond(uint256 _etxPerSecond) external onlyOwner {
        massUpdatePools();
        etxPerSecond = _etxPerSecond;
        emit EmissionRateUpdated(_etxPerSecond);
    }

    function pendingEtx(uint256 _pid, address _user) external view returns (uint256) {
        PoolInfo memory pool = poolInfo[_pid];
        UserInfo memory user = userInfo[_pid][_user];
        uint256 acc = pool.accEtxPerShare;
        uint256 lpSupply = pool.lpToken.balanceOf(address(this));
        if (block.timestamp > pool.lastRewardTime && lpSupply > 0 && totalAllocPoint > 0) {
            uint256 dt = block.timestamp - pool.lastRewardTime;
            uint256 etxReward = (dt * etxPerSecond * pool.allocPoint) / totalAllocPoint;
            acc += (etxReward * PRECISION) / lpSupply;
        }
        return (user.amount * acc) / PRECISION - user.rewardDebt;
    }

    function massUpdatePools() public {
        uint256 len = poolInfo.length;
        for (uint256 i = 0; i < len; i++) {
            updatePool(i);
        }
    }

    function updatePool(uint256 _pid) public {
        PoolInfo storage pool = poolInfo[_pid];
        if (block.timestamp <= pool.lastRewardTime) return;
        uint256 lpSupply = pool.lpToken.balanceOf(address(this));
        if (lpSupply == 0 || totalAllocPoint == 0) {
            pool.lastRewardTime = uint64(block.timestamp);
            return;
        }
        uint256 dt = block.timestamp - pool.lastRewardTime;
        uint256 etxReward = (dt * etxPerSecond * pool.allocPoint) / totalAllocPoint;
        pool.accEtxPerShare += (etxReward * PRECISION) / lpSupply;
        pool.lastRewardTime = uint64(block.timestamp);
    }

    function deposit(uint256 _pid, uint256 _amount) external nonReentrant {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        updatePool(_pid);
        if (user.amount > 0) {
            uint256 pending = (user.amount * pool.accEtxPerShare) / PRECISION - user.rewardDebt;
            if (pending > 0) {
                _safeEtxTransfer(msg.sender, pending);
                emit Harvest(msg.sender, _pid, pending);
            }
        }
        if (_amount > 0) {
            pool.lpToken.safeTransferFrom(msg.sender, address(this), _amount);
            user.amount += _amount;
        }
        user.rewardDebt = (user.amount * pool.accEtxPerShare) / PRECISION;
        emit Deposit(msg.sender, _pid, _amount);
    }

    function withdraw(uint256 _pid, uint256 _amount) external nonReentrant {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        require(user.amount >= _amount, "MC: withdraw too much");
        updatePool(_pid);
        uint256 pending = (user.amount * pool.accEtxPerShare) / PRECISION - user.rewardDebt;
        if (pending > 0) {
            _safeEtxTransfer(msg.sender, pending);
            emit Harvest(msg.sender, _pid, pending);
        }
        if (_amount > 0) {
            user.amount -= _amount;
            pool.lpToken.safeTransfer(msg.sender, _amount);
        }
        user.rewardDebt = (user.amount * pool.accEtxPerShare) / PRECISION;
        emit Withdraw(msg.sender, _pid, _amount);
    }

    function harvest(uint256 _pid) external nonReentrant {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        updatePool(_pid);
        uint256 pending = (user.amount * pool.accEtxPerShare) / PRECISION - user.rewardDebt;
        user.rewardDebt = (user.amount * pool.accEtxPerShare) / PRECISION;
        if (pending > 0) {
            _safeEtxTransfer(msg.sender, pending);
            emit Harvest(msg.sender, _pid, pending);
        }
    }

    function emergencyWithdraw(uint256 _pid) external nonReentrant {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        uint256 amount = user.amount;
        user.amount = 0;
        user.rewardDebt = 0;
        pool.lpToken.safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, _pid, amount);
    }

    function _safeEtxTransfer(address to, uint256 amount) internal {
        uint256 bal = etx.balanceOf(address(this));
        uint256 actual = amount > bal ? bal : amount;
        if (actual > 0) etx.safeTransfer(to, actual);
    }
}
