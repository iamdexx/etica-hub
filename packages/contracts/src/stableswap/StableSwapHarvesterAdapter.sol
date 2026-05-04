// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IStableSwap {
    function claimAdminFees() external returns (uint256, uint256);
    function addLiquidity(uint256 amountEtx, uint256 amountStEtx, uint256 minMintAmount, address to)
        external
        returns (uint256);
}

interface IRewardSink {
    function distributeRewards(uint256 amount) external;
}

/// @title StableSwapHarvesterAdapter — fee router for EticaStableSwap pools
/// @notice Accumulates admin-fee payouts from a stableswap pool, converts
///         them to a single ETX-denominated lump, and splits that lump per
///         the same 10/10/40/40 pattern used by {TreasuryHarvester}.
///
///         Why a separate adapter:
///           {TreasuryHarvester} works by BURNING a slice of treasury LP on
///           every run, which we explicitly do NOT want for this pool — the
///           treasury LP here is locked for 10 years inside
///           {LiquidityTimelock10y}. Instead the stableswap streams admin
///           fees out of its accumulator on every swap (no LP burn, principal
///           untouched). This adapter is the bridge between that fee-stream
///           shape and the existing 10/10/40/40 treasury machinery.
///
///         Distribution pattern (mirrors TreasuryHarvester defaults):
///           - 10% → stETX vault (auto-yield to all stakers)
///           - 10% → ETXFarms (LP-staking rewards)
///           - 40% → permanent POL: paired into the stableswap pool itself
///                   and the LP shares burned to address(0xdead). The pool
///                   gets deeper forever; no operator can re-extract.
///           - 40% → treasury wallet
///
///         The 40% POL burn here goes INTO the stableswap pool (not the
///         ETX/wETI pool that the V2 harvester uses) because:
///           1. The stableswap pool is exactly where this fee stream came
///              from, so paying it back makes the pool's own depth grow.
///           2. The pool is rate-aware, so half-buying stETX before pairing
///              is unnecessary — we already have stETX (from the admin-fee
///              sweep) and just need to balance it 50/50 in xp space.
///           3. POL going to a fully-locked pool with permanently-burned
///              LP is the strictest possible "permanent depth" guarantee.
///
///         Trust model:
///           - `owner()` (treasury multisig) sets bps splits, sinks, treasury
///             address, and can update the underlying pool reference (e.g.
///             when migrating to a v2 pool). Owner cannot exfiltrate idle
///             funds — every distribution leaves nothing behind in this
///             contract.
///           - `harvest()` is permissionless; anyone can crank it. There
///             is no privileged caller, no caller tip from this adapter
///             (we expect the V2 harvester crank to also poke this one).
contract StableSwapHarvesterAdapter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Dead address that receives permanently-burned POL LP.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The stableswap pool this adapter pulls fees from.
    IStableSwap public pool;

    /// @notice ETX token (matches the pool's ETX leg).
    IERC20 public immutable etx;

    /// @notice stETX vault token (matches the pool's stETX leg).
    IERC4626 public immutable stEtx;

    /// @notice stETX yield sink (calls {IRewardSink.distributeRewards}).
    address public stakedEtxSink;

    /// @notice Farms reward sink (calls {IRewardSink.distributeRewards}).
    address public farmsSink;

    /// @notice Treasury wallet for the residual slice.
    address public treasury;

    /// @notice Reward split in basis points. Must sum to 10_000.
    uint16 public stakedEtxBps;
    uint16 public farmsBps;
    uint16 public polBurnBps;
    uint16 public treasuryBps;

    event PoolUpdated(address indexed newPool);
    event SinksUpdated(address indexed stakedEtxSink, address indexed farmsSink);
    event TreasuryUpdated(address indexed newTreasury);
    event SplitUpdated(uint16 stakedBps, uint16 farmsBps, uint16 polBps, uint16 treasuryBps);
    event Harvested(
        address indexed caller,
        uint256 totalEtxHarvested,
        uint256 stakedSlice,
        uint256 farmsSlice,
        uint256 polSlice,
        uint256 treasurySlice,
        uint256 polLpBurned
    );
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error BpsSumInvalid();
    error NothingToHarvest();

    constructor(
        address _owner,
        IStableSwap _pool,
        IERC20 _etx,
        IERC4626 _stEtx,
        address _stakedEtxSink,
        address _farmsSink,
        address _treasury
    ) Ownable(_owner) {
        if (
            address(_pool) == address(0) || address(_etx) == address(0)
                || address(_stEtx) == address(0) || _treasury == address(0)
        ) revert ZeroAddress();
        if (_stEtx.asset() != address(_etx)) revert ZeroAddress();

        pool = _pool;
        etx = _etx;
        stEtx = _stEtx;
        stakedEtxSink = _stakedEtxSink;
        farmsSink = _farmsSink;
        treasury = _treasury;

        // Default: same 10/10/40/40 as {TreasuryHarvester}.
        stakedEtxBps = 1_000;
        farmsBps = 1_000;
        polBurnBps = 4_000;
        treasuryBps = 4_000;
    }

    // -------------------------------------------------------------------------
    // Harvest (permissionless)
    // -------------------------------------------------------------------------

    /// @notice Pull admin fees from the pool, redeem stETX → ETX, split per bps.
    function harvest() external nonReentrant returns (uint256 totalEtx, uint256 polLpBurned) {
        // 1. Pull accumulated admin fees (both legs) from the pool.
        pool.claimAdminFees();
        uint256 etxBal = etx.balanceOf(address(this));
        uint256 stEtxBal = IERC20(address(stEtx)).balanceOf(address(this));
        if (etxBal == 0 && stEtxBal == 0) revert NothingToHarvest();

        // 2. Convert stETX → ETX (NAV-perfect, no slippage).
        if (stEtxBal != 0) {
            uint256 redeemed = stEtx.redeem(stEtxBal, address(this), address(this));
            etxBal += redeemed;
        }
        totalEtx = etxBal;

        // 3. Slice. Underflow-safe since bps sum to 10_000.
        uint256 stakedSlice = (totalEtx * stakedEtxBps) / 10_000;
        uint256 farmsSlice = (totalEtx * farmsBps) / 10_000;
        uint256 polSlice = (totalEtx * polBurnBps) / 10_000;
        uint256 treasurySlice = totalEtx - stakedSlice - farmsSlice - polSlice;

        // 4. Distribute.
        if (stakedSlice != 0 && stakedEtxSink != address(0)) {
            etx.forceApprove(stakedEtxSink, stakedSlice);
            IRewardSink(stakedEtxSink).distributeRewards(stakedSlice);
        } else if (stakedSlice != 0) {
            // Sink not yet wired: fold into treasury.
            treasurySlice += stakedSlice;
            stakedSlice = 0;
        }

        if (farmsSlice != 0 && farmsSink != address(0)) {
            etx.forceApprove(farmsSink, farmsSlice);
            IRewardSink(farmsSink).distributeRewards(farmsSlice);
        } else if (farmsSlice != 0) {
            treasurySlice += farmsSlice;
            farmsSlice = 0;
        }

        if (polSlice != 0) {
            polLpBurned = _polBurnIntoPool(polSlice);
        }

        if (treasurySlice != 0) {
            etx.safeTransfer(treasury, treasurySlice);
        }

        emit Harvested(
            msg.sender, totalEtx, stakedSlice, farmsSlice, polSlice, treasurySlice, polLpBurned
        );
    }

    /// @dev Convert `etxAmount` of ETX into a balanced (ETX, stETX) pair at
    ///      live NAV, deposit into the pool, and burn the resulting LP
    ///      shares to {DEAD}. Returns the LP burned.
    function _polBurnIntoPool(uint256 etxAmount) internal returns (uint256 lpBurned) {
        // Stake half into stETX. The pool is rate-aware, so this minimises
        // imbalance fees: half the pol-slice in ETX, half in stETX, both
        // representing the same ETX-equivalent value at live NAV.
        uint256 etxToStake = etxAmount / 2;
        uint256 etxToPair = etxAmount - etxToStake;

        etx.forceApprove(address(stEtx), etxToStake);
        uint256 stEtxOut = stEtx.deposit(etxToStake, address(this));

        etx.forceApprove(address(pool), etxToPair);
        IERC20(address(stEtx)).forceApprove(address(pool), stEtxOut);
        lpBurned = pool.addLiquidity(etxToPair, stEtxOut, 0, DEAD);
    }

    // -------------------------------------------------------------------------
    // Owner controls
    // -------------------------------------------------------------------------

    function setPool(IStableSwap newPool) external onlyOwner {
        if (address(newPool) == address(0)) revert ZeroAddress();
        pool = newPool;
        emit PoolUpdated(address(newPool));
    }

    function setSinks(address newStakedEtxSink, address newFarmsSink) external onlyOwner {
        stakedEtxSink = newStakedEtxSink;
        farmsSink = newFarmsSink;
        emit SinksUpdated(newStakedEtxSink, newFarmsSink);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function setSplit(uint16 _stakedBps, uint16 _farmsBps, uint16 _polBps, uint16 _treasuryBps)
        external
        onlyOwner
    {
        if (uint256(_stakedBps) + _farmsBps + _polBps + _treasuryBps != 10_000) {
            revert BpsSumInvalid();
        }
        stakedEtxBps = _stakedBps;
        farmsBps = _farmsBps;
        polBurnBps = _polBps;
        treasuryBps = _treasuryBps;
        emit SplitUpdated(_stakedBps, _farmsBps, _polBps, _treasuryBps);
    }

    /// @notice Rescue stuck tokens that aren't part of the routine flow.
    ///         Useful for accidental airdrops or governance tokens received
    ///         by this contract; harvest distributes everything else.
    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Rescued(address(token), to, amount);
    }
}
