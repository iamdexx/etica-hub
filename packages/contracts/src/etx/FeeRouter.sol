// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IEticaSwapPair} from "../swap/interfaces/IEticaSwapPair.sol";

interface IEticaSwapRouterLike {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IxETXVault {
    function notifyRewardAmount(uint256 amount) external;
    function rewardToken() external view returns (address);
}

/// @title EticaHub FeeRouter
/// @notice Designated as the factory's `feeTo`. Receives 1/6 of the 0.30% swap
///         fee as LP tokens from every pair, then harvests them on demand:
///
///         1. `harvestPair(pair)` — burn LP tokens to receive underlying.
///         2. `swapToEti(tokenIn, path, minOut)` — convert non-ETI tokens to ETI.
///         3. `distribute()` — forward ETI balance to the xETXVault as rewards.
///
///         Anyone may call these; the contract can only ever route funds to the
///         configured vault (as ETI rewards), so there is no extraction vector.
contract FeeRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IEticaSwapRouterLike public immutable swapRouter;
    IERC20 public immutable eti;
    IxETXVault public immutable vault;

    uint256 public minDistribute;

    event Harvested(address indexed pair, uint256 amount0, uint256 amount1);
    event SwappedToEti(address indexed tokenIn, uint256 amountIn, uint256 amountOut);
    event Distributed(uint256 amount);
    event MinDistributeUpdated(uint256 minDistribute);

    constructor(
        IEticaSwapRouterLike _swapRouter,
        IERC20 _eti,
        IxETXVault _vault,
        address _owner,
        uint256 _minDistribute
    ) Ownable(_owner) {
        require(address(_swapRouter) != address(0), "FR: zero router");
        require(address(_eti) != address(0), "FR: zero eti");
        require(address(_vault) != address(0), "FR: zero vault");
        require(_vault.rewardToken() == address(_eti), "FR: vault mismatch");
        swapRouter = _swapRouter;
        eti = _eti;
        vault = _vault;
        minDistribute = _minDistribute;
    }

    function setMinDistribute(uint256 _min) external onlyOwner {
        minDistribute = _min;
        emit MinDistributeUpdated(_min);
    }

    /// @notice Burn LP tokens held by this contract (accrued from `feeTo`)
    ///         to receive the underlying token0/token1 from `pair`.
    function harvestPair(address pair)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        uint256 bal = IEticaSwapPair(pair).balanceOf(address(this));
        if (bal == 0) return (0, 0);
        IEticaSwapPair(pair).transfer(pair, bal);
        (amount0, amount1) = IEticaSwapPair(pair).burn(address(this));
        emit Harvested(pair, amount0, amount1);
    }

    /// @notice Convert held `tokenIn` to ETI via the provided path.
    ///         `path[0]` must equal `tokenIn` and `path[last]` must equal ETI.
    function swapToEti(address tokenIn, address[] calldata path, uint256 minOut)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        require(path.length >= 2, "FR: bad path");
        require(path[0] == tokenIn, "FR: path[0] != in");
        require(path[path.length - 1] == address(eti), "FR: path end != eti");
        require(tokenIn != address(eti), "FR: already eti");

        uint256 amountIn = IERC20(tokenIn).balanceOf(address(this));
        if (amountIn == 0) return 0;

        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);
        uint256[] memory amounts = swapRouter.swapExactTokensForTokens(
            amountIn, minOut, path, address(this), block.timestamp
        );
        amountOut = amounts[amounts.length - 1];
        emit SwappedToEti(tokenIn, amountIn, amountOut);
    }

    /// @notice Forward held ETI to the vault and start/extend a reward epoch.
    function distribute() external nonReentrant returns (uint256 amount) {
        amount = eti.balanceOf(address(this));
        require(amount >= minDistribute, "FR: below min");
        eti.safeTransfer(address(vault), amount);
        vault.notifyRewardAmount(amount);
        emit Distributed(amount);
    }
}
