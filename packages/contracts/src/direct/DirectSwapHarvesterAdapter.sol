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
}

/// @title DirectSwapHarvesterAdapter
/// @notice `feeTo` of {EticaDirectFactory}. Every direct pair mints 1/6 of its
///         1.00% swap fee as LP to this contract (standard V2 mechanics); the
///         harvest burns that LP, swaps both legs into ETX through the
///         hub-and-spoke EticaSwap router (every venue token has an ETX pair
///         there by construction) and splits the ETX between stETX holders and
///         the treasury. Default 50/50.
/// @dev    Harvest is keeper-called rather than permissionless because it
///         swaps on the hub: the caller supplies a min ETX out per leg and the
///         keeper is expected to quote it a block earlier. `rescue` only moves
///         tokens that are sitting here, never pair reserves.
contract DirectSwapHarvesterAdapter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IEticaDirectFactory public immutable factory;
    IHubRouter public immutable hubRouter;
    IERC20 public immutable etx;

    address public stakedEtxSink;
    address public treasury;
    uint16 public stakedEtxBps;
    mapping(address => bool) public keepers;

    struct LegPlan {
        address pair;
        uint256 minEtxOut0;
        uint256 minEtxOut1;
    }

    event Harvested(
        address indexed caller, uint256 totalEtx, uint256 stakedSlice, uint256 treasurySlice
    );
    event SplitUpdated(uint16 stakedBps);
    event SinksUpdated(address indexed stakedEtxSink, address indexed treasury);
    event KeeperSet(address indexed keeper, bool allowed);
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
        address _treasury
    ) Ownable(_owner) {
        if (
            address(_factory) == address(0) || address(_hubRouter) == address(0)
                || address(_etx) == address(0) || _stakedEtxSink == address(0)
                || _treasury == address(0)
        ) revert ZeroAddress();
        factory = _factory;
        hubRouter = _hubRouter;
        etx = _etx;
        stakedEtxSink = _stakedEtxSink;
        treasury = _treasury;
        stakedEtxBps = 5_000;
        keepers[_owner] = true;
    }

    /// @notice Burn accrued fee LP on `plans[i].pair`, convert each leg to ETX
    ///         on the hub router and split. Legs that already are ETX skip the
    ///         swap; `minEtxOut*` for them is ignored.
    function harvest(LegPlan[] calldata plans)
        external
        nonReentrant
        returns (uint256 totalEtx, uint256 stakedSlice, uint256 treasurySlice)
    {
        if (!keepers[msg.sender]) revert NotKeeper();
        for (uint256 i; i < plans.length; i++) {
            LegPlan calldata p = plans[i];
            if (!factory.isPair(p.pair)) revert NotVenuePair(p.pair);
            IEticaSwapPair pair = IEticaSwapPair(p.pair);
            uint256 lp = pair.balanceOf(address(this));
            if (lp == 0) continue;
            IERC20(p.pair).safeTransfer(p.pair, lp);
            (uint256 amount0, uint256 amount1) = pair.burn(address(this));
            _toEtx(pair.token0(), amount0, p.minEtxOut0);
            _toEtx(pair.token1(), amount1, p.minEtxOut1);
        }

        totalEtx = etx.balanceOf(address(this));
        if (totalEtx == 0) revert NothingToHarvest();

        stakedSlice = (totalEtx * stakedEtxBps) / 10_000;
        treasurySlice = totalEtx - stakedSlice;
        if (stakedSlice != 0) {
            etx.forceApprove(stakedEtxSink, stakedSlice);
            IRewardSink(stakedEtxSink).distributeRewards(stakedSlice);
        }
        if (treasurySlice != 0) etx.safeTransfer(treasury, treasurySlice);
        emit Harvested(msg.sender, totalEtx, stakedSlice, treasurySlice);
    }

    function _toEtx(address token, uint256 amount, uint256 minEtxOut) internal {
        if (amount == 0 || token == address(etx)) return;
        IERC20(token).forceApprove(address(hubRouter), amount);
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = address(etx);
        hubRouter.swapExactTokensForTokens(amount, minEtxOut, path, address(this), block.timestamp);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setSinks(address _stakedEtxSink, address _treasury) external onlyOwner {
        if (_stakedEtxSink == address(0) || _treasury == address(0)) revert ZeroAddress();
        stakedEtxSink = _stakedEtxSink;
        treasury = _treasury;
        emit SinksUpdated(_stakedEtxSink, _treasury);
    }

    function setSplit(uint16 _stakedBps) external onlyOwner {
        if (_stakedBps > 10_000) revert BpsInvalid();
        stakedEtxBps = _stakedBps;
        emit SplitUpdated(_stakedBps);
    }

    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Rescued(address(token), to, amount);
    }
}
