// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IEticaDirectFactory} from "./IEticaDirectFactory.sol";
import {IEticaSwapPair} from "../swap/interfaces/IEticaSwapPair.sol";

interface IRewardSink {
    function distributeRewards(uint256 amount) external;
}

interface IHubRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}

/// @title DirectSwapHarvesterAdapter
/// @notice `feeTo` of {EticaDirectFactory}. Every direct pair mints 1/6 of its
///         1.00% swap fee as LP to this contract (standard V2 mechanics); the
///         harvest burns that LP, swaps both legs into ETX through the
///         hub-and-spoke EticaSwap router (every venue token has an ETX pair
///         there by construction) and splits the ETX exactly like
///         {TreasuryHarvester}: 10% stETX / 10% farms / 40% POL / 40% treasury.
///         The POL slice is bought back into the venue pair the fee came from
///         and the LP is burned to {DEAD}, so the direct pools deepen
///         permanently with use. Hub windows ({EticaDirectMetaPair}) forward
///         their fee here in kind instead of as LP; their POL slice is
///         deposited back through the window into the hub pools.
/// @dev    Harvest is keeper-called rather than permissionless because it
///         swaps on the hub: the caller supplies a min ETX out per leg and the
///         keeper is expected to quote it a block earlier. `rescue` only moves
///         tokens that are sitting here, never pair reserves.
contract DirectSwapHarvesterAdapter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IEticaDirectFactory public immutable factory;
    IHubRouter public immutable hubRouter;
    IERC20 public immutable etx;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public stakedEtxSink;
    address public farmsSink;
    address public treasury;
    /// @notice Token the treasury slice is paid in (USDC.e). Zero or ETX pays ETX.
    address public treasuryToken;
    uint16 public stakedEtxBps;
    uint16 public farmsBps;
    uint16 public polBurnBps;
    uint16 public treasuryBps;
    mapping(address => bool) public keepers;

    /// @param minEtxOut0/1  min ETX for selling each burned leg on the hub.
    /// @param minPolOut0/1  min token0/token1 when buying the POL slice back
    ///                      (ignored for an ETX leg).
    struct LegPlan {
        address pair;
        uint256 minEtxOut0;
        uint256 minEtxOut1;
        uint256 minPolOut0;
        uint256 minPolOut1;
    }

    event Harvested(
        address indexed caller,
        uint256 totalEtx,
        uint256 stakedSlice,
        uint256 farmsSlice,
        uint256 polSlice,
        uint256 treasurySlice,
        uint256 polLpBurned
    );
    event SplitUpdated(uint16 stakedBps, uint16 farmsBps, uint16 polBps, uint16 treasuryBps);
    event SinksUpdated(
        address indexed stakedEtxSink, address indexed farmsSink, address indexed treasury
    );
    event KeeperSet(address indexed keeper, bool allowed);
    event TreasuryTokenSet(address indexed token);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error NotKeeper();
    error NotVenuePair(address pair);
    error BpsInvalid();
    error NothingToHarvest();

    constructor(
        address _owner,
        IEticaDirectFactory _factory,
        IHubRouter _hubRouter,
        IERC20 _etx,
        address _stakedEtxSink,
        address _farmsSink,
        address _treasury
    ) Ownable(_owner) {
        if (
            address(_factory) == address(0) || address(_hubRouter) == address(0)
                || address(_etx) == address(0) || _treasury == address(0)
        ) revert ZeroAddress();
        factory = _factory;
        hubRouter = _hubRouter;
        etx = _etx;
        stakedEtxSink = _stakedEtxSink;
        farmsSink = _farmsSink;
        treasury = _treasury;
        stakedEtxBps = 1_000;
        farmsBps = 1_000;
        polBurnBps = 4_000;
        treasuryBps = 4_000;
        keepers[_owner] = true;
    }

    /// @notice Burn accrued fee LP on every `plans[i].pair`, convert each leg
    ///         to ETX on the hub router, then split 10/10/40/40. The POL slice
    ///         is divided equally across the harvested pairs, bought back into
    ///         each one and the LP burned to {DEAD}. Legs that already are ETX
    ///         skip the hub swap; their min-outs are ignored. Sinks left at
    ///         zero fold their slice into the treasury. Legs too small to buy
    ///         any ETX are left for a later run. The treasury slice is sold
    ///         for {treasuryToken} (min `minTreasuryOut`) when one is set.
    function harvest(LegPlan[] calldata plans, uint256 minTreasuryOut)
        external
        nonReentrant
        returns (uint256 totalEtx, uint256 polLpBurned)
    {
        if (!keepers[msg.sender]) revert NotKeeper();
        uint256 harvestedPairs;
        bool[] memory harvested = new bool[](plans.length);
        for (uint256 i; i < plans.length; i++) {
            LegPlan calldata p = plans[i];
            if (!factory.isPair(p.pair)) revert NotVenuePair(p.pair);
            IEticaSwapPair pair = IEticaSwapPair(p.pair);
            uint256 amount0;
            uint256 amount1;
            if (factory.isMetaPair(p.pair)) {
                // Windows forward their fee in kind: sell what sits here. Two
                // windows can share a leg token, so a listed window always
                // counts for the POL split even if a sibling sold its leg.
                amount0 = IERC20(pair.token0()).balanceOf(address(this));
                amount1 = IERC20(pair.token1()).balanceOf(address(this));
            } else {
                uint256 lp = pair.balanceOf(address(this));
                if (lp == 0) continue;
                IERC20(p.pair).safeTransfer(p.pair, lp);
                (amount0, amount1) = pair.burn(address(this));
            }
            _toEtx(pair.token0(), amount0, p.minEtxOut0);
            _toEtx(pair.token1(), amount1, p.minEtxOut1);
            harvested[i] = true;
            harvestedPairs++;
        }

        totalEtx = etx.balanceOf(address(this));
        if (totalEtx == 0) revert NothingToHarvest();

        uint256 stakedSlice = (totalEtx * stakedEtxBps) / 10_000;
        uint256 farmsSlice = (totalEtx * farmsBps) / 10_000;
        uint256 polSlice = (totalEtx * polBurnBps) / 10_000;
        uint256 treasurySlice = totalEtx - stakedSlice - farmsSlice - polSlice;

        if (stakedSlice != 0 && stakedEtxSink != address(0)) {
            etx.forceApprove(stakedEtxSink, stakedSlice);
            IRewardSink(stakedEtxSink).distributeRewards(stakedSlice);
        } else {
            treasurySlice += stakedSlice;
            stakedSlice = 0;
        }
        if (farmsSlice != 0 && farmsSink != address(0)) {
            etx.forceApprove(farmsSink, farmsSlice);
            IRewardSink(farmsSink).distributeRewards(farmsSlice);
        } else {
            treasurySlice += farmsSlice;
            farmsSlice = 0;
        }
        if (polSlice != 0 && harvestedPairs != 0) {
            uint256 perPair = polSlice / harvestedPairs;
            for (uint256 i; i < plans.length; i++) {
                if (!harvested[i]) continue;
                polLpBurned += _polBurnIntoPair(plans[i], perPair);
            }
            // Rounding dust from the per-pair division stays with the treasury.
            treasurySlice += polSlice - perPair * harvestedPairs;
        } else {
            treasurySlice += polSlice;
            polSlice = 0;
        }
        _payTreasury(treasurySlice, minTreasuryOut);
        emit Harvested(
            msg.sender, totalEtx, stakedSlice, farmsSlice, polSlice, treasurySlice, polLpBurned
        );
    }

    /// @dev Buy `etxAmount` of ETX half-and-half into the pair's two tokens on
    ///      the hub, deposit into the pair and burn the LP to {DEAD}. Any
    ///      ratio mismatch is left in the pair, i.e. donated to its LPs.
    function _polBurnIntoPair(LegPlan calldata p, uint256 etxAmount)
        internal
        returns (uint256 lpBurned)
    {
        if (etxAmount == 0) return 0;
        IEticaSwapPair pair = IEticaSwapPair(p.pair);
        if (factory.isMetaPair(p.pair)) {
            // A window takes loose ETX and deposits it into the hub itself;
            // its shares are not redeemable, so holding them here locks them.
            etx.safeTransfer(p.pair, etxAmount);
            return pair.mint(address(this));
        }
        address token0 = pair.token0();
        address token1 = pair.token1();
        uint256 half = etxAmount / 2;
        _fromEtx(token0, half, p.minPolOut0, p.pair);
        _fromEtx(token1, etxAmount - half, p.minPolOut1, p.pair);
        lpBurned = pair.mint(address(this));
        IERC20(p.pair).safeTransfer(DEAD, lpBurned);
    }

    function _fromEtx(address token, uint256 etxAmount, uint256 minOut, address to) internal {
        if (etxAmount == 0) return;
        if (token == address(etx)) {
            etx.safeTransfer(to, etxAmount);
            return;
        }
        etx.forceApprove(address(hubRouter), etxAmount);
        address[] memory path = new address[](2);
        path[0] = address(etx);
        path[1] = token;
        hubRouter.swapExactTokensForTokens(etxAmount, minOut, path, to, block.timestamp);
    }

    function _toEtx(address token, uint256 amount, uint256 minEtxOut) internal {
        if (amount == 0 || token == address(etx)) return;
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = address(etx);
        if (hubRouter.getAmountsOut(amount, path)[1] == 0) return;
        IERC20(token).forceApprove(address(hubRouter), amount);
        hubRouter.swapExactTokensForTokens(amount, minEtxOut, path, address(this), block.timestamp);
    }

    function _payTreasury(uint256 etxAmount, uint256 minOut) internal {
        if (etxAmount == 0) return;
        address token = treasuryToken;
        if (token == address(0) || token == address(etx)) {
            etx.safeTransfer(treasury, etxAmount);
            return;
        }
        address[] memory path = new address[](2);
        path[0] = address(etx);
        path[1] = token;
        if (hubRouter.getAmountsOut(etxAmount, path)[1] == 0) {
            // Too small to buy any of the treasury token: pay ETX rather than revert.
            etx.safeTransfer(treasury, etxAmount);
            return;
        }
        etx.forceApprove(address(hubRouter), etxAmount);
        hubRouter.swapExactTokensForTokens(etxAmount, minOut, path, treasury, block.timestamp);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    /// @notice Zero for stETX / farms folds that slice into the treasury.
    function setSinks(address _stakedEtxSink, address _farmsSink, address _treasury)
        external
        onlyOwner
    {
        if (_treasury == address(0)) revert ZeroAddress();
        stakedEtxSink = _stakedEtxSink;
        farmsSink = _farmsSink;
        treasury = _treasury;
        emit SinksUpdated(_stakedEtxSink, _farmsSink, _treasury);
    }

    function setTreasuryToken(address token) external onlyOwner {
        treasuryToken = token;
        emit TreasuryTokenSet(token);
    }

    function setSplit(uint16 _stakedBps, uint16 _farmsBps, uint16 _polBps, uint16 _treasuryBps)
        external
        onlyOwner
    {
        if (uint256(_stakedBps) + _farmsBps + _polBps + _treasuryBps != 10_000) {
            revert BpsInvalid();
        }
        stakedEtxBps = _stakedBps;
        farmsBps = _farmsBps;
        polBurnBps = _polBps;
        treasuryBps = _treasuryBps;
        emit SplitUpdated(_stakedBps, _farmsBps, _polBps, _treasuryBps);
    }

    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Rescued(address(token), to, amount);
    }
}
