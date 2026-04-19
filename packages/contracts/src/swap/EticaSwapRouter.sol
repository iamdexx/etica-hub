// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {IEticaSwapFactory} from "./interfaces/IEticaSwapFactory.sol";
import {IEticaSwapPair} from "./interfaces/IEticaSwapPair.sol";
import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {IWEGAZ} from "./interfaces/IWEGAZ.sol";
import {EticaSwapLibrary} from "./libraries/EticaSwapLibrary.sol";
import {TransferHelper} from "./libraries/TransferHelper.sol";

/// @title EticaSwap V2 router
/// @notice User-facing entry point for swap + liquidity ops.
///         Supports ERC20/ERC20 and EGAZ/ERC20 pairs (EGAZ wrapped via WEGAZ).
contract EticaSwapRouter {
    address public immutable factory;
    address public immutable WEGAZ_TOKEN;

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "ESwap: EXPIRED");
        _;
    }

    constructor(address _factory, address _wegaz) {
        factory = _factory;
        WEGAZ_TOKEN = _wegaz;
    }

    receive() external payable {
        // Only WEGAZ may send native EGAZ here (on withdraw).
        require(msg.sender == WEGAZ_TOKEN, "ESwap: NOT_WEGAZ");
    }

    // ------------------------------------------------------------------ ADD LIQUIDITY

    function _addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) internal returns (uint256 amountA, uint256 amountB) {
        if (IEticaSwapFactory(factory).getPair(tokenA, tokenB) == address(0)) {
            IEticaSwapFactory(factory).createPair(tokenA, tokenB);
        }
        (uint256 reserveA, uint256 reserveB) = _reservesOrZero(tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = EticaSwapLibrary.quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                require(amountBOptimal >= amountBMin, "ESwap: INSUFFICIENT_B_AMOUNT");
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = EticaSwapLibrary.quote(amountBDesired, reserveB, reserveA);
                assert(amountAOptimal <= amountADesired);
                require(amountAOptimal >= amountAMin, "ESwap: INSUFFICIENT_A_AMOUNT");
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }

    function _reservesOrZero(address tokenA, address tokenB)
        private
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        address pair = IEticaSwapFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) return (0, 0);
        (address token0,) = EticaSwapLibrary.sortTokens(tokenA, tokenB);
        (uint112 r0, uint112 r1,) = IEticaSwapPair(pair).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (r0, r1) : (r1, r0);
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    )
        external
        ensure(deadline)
        returns (uint256 amountA, uint256 amountB, uint256 liquidity)
    {
        (amountA, amountB) =
            _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
        address pair = EticaSwapLibrary.pairFor(factory, tokenA, tokenB);
        TransferHelper.safeTransferFrom(tokenA, msg.sender, pair, amountA);
        TransferHelper.safeTransferFrom(tokenB, msg.sender, pair, amountB);
        liquidity = IEticaSwapPair(pair).mint(to);
    }

    function addLiquidityEGAZ(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountEGAZMin,
        address to,
        uint256 deadline
    )
        external
        payable
        ensure(deadline)
        returns (uint256 amountToken, uint256 amountEGAZ, uint256 liquidity)
    {
        (amountToken, amountEGAZ) = _addLiquidity(
            token,
            WEGAZ_TOKEN,
            amountTokenDesired,
            msg.value,
            amountTokenMin,
            amountEGAZMin
        );
        address pair = EticaSwapLibrary.pairFor(factory, token, WEGAZ_TOKEN);
        TransferHelper.safeTransferFrom(token, msg.sender, pair, amountToken);
        IWEGAZ(WEGAZ_TOKEN).deposit{value: amountEGAZ}();
        assert(IWEGAZ(WEGAZ_TOKEN).transfer(pair, amountEGAZ));
        liquidity = IEticaSwapPair(pair).mint(to);
        if (msg.value > amountEGAZ) TransferHelper.safeTransferEGAZ(msg.sender, msg.value - amountEGAZ);
    }

    // ------------------------------------------------------------------ REMOVE LIQUIDITY

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    )
        public
        ensure(deadline)
        returns (uint256 amountA, uint256 amountB)
    {
        address pair = EticaSwapLibrary.pairFor(factory, tokenA, tokenB);
        IEticaSwapPair(pair).transferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = IEticaSwapPair(pair).burn(to);
        (address token0,) = EticaSwapLibrary.sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        require(amountA >= amountAMin, "ESwap: INSUFFICIENT_A_AMOUNT");
        require(amountB >= amountBMin, "ESwap: INSUFFICIENT_B_AMOUNT");
    }

    function removeLiquidityEGAZ(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountEGAZMin,
        address to,
        uint256 deadline
    )
        public
        ensure(deadline)
        returns (uint256 amountToken, uint256 amountEGAZ)
    {
        (amountToken, amountEGAZ) = removeLiquidity(
            token,
            WEGAZ_TOKEN,
            liquidity,
            amountTokenMin,
            amountEGAZMin,
            address(this),
            deadline
        );
        TransferHelper.safeTransfer(token, to, amountToken);
        IWEGAZ(WEGAZ_TOKEN).withdraw(amountEGAZ);
        TransferHelper.safeTransferEGAZ(to, amountEGAZ);
    }

    // ------------------------------------------------------------------ SWAPS

    function _swap(uint256[] memory amounts, address[] memory path, address _to) internal {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = EticaSwapLibrary.sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) =
                input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address to =
                i < path.length - 2 ? EticaSwapLibrary.pairFor(factory, output, path[i + 2]) : _to;
            IEticaSwapPair(EticaSwapLibrary.pairFor(factory, input, output)).swap(
                amount0Out, amount1Out, to, new bytes(0)
            );
        }
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    )
        external
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        amounts = EticaSwapLibrary.getAmountsOut(factory, amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "ESwap: INSUFFICIENT_OUTPUT_AMOUNT");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, EticaSwapLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, to);
    }

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    )
        external
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        amounts = EticaSwapLibrary.getAmountsIn(factory, amountOut, path);
        require(amounts[0] <= amountInMax, "ESwap: EXCESSIVE_INPUT_AMOUNT");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, EticaSwapLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, to);
    }

    function swapExactEGAZForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    )
        external
        payable
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        require(path[0] == WEGAZ_TOKEN, "ESwap: INVALID_PATH");
        amounts = EticaSwapLibrary.getAmountsOut(factory, msg.value, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "ESwap: INSUFFICIENT_OUTPUT_AMOUNT");
        IWEGAZ(WEGAZ_TOKEN).deposit{value: amounts[0]}();
        assert(
            IWEGAZ(WEGAZ_TOKEN).transfer(EticaSwapLibrary.pairFor(factory, path[0], path[1]), amounts[0])
        );
        _swap(amounts, path, to);
    }

    function swapTokensForExactEGAZ(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    )
        external
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        require(path[path.length - 1] == WEGAZ_TOKEN, "ESwap: INVALID_PATH");
        amounts = EticaSwapLibrary.getAmountsIn(factory, amountOut, path);
        require(amounts[0] <= amountInMax, "ESwap: EXCESSIVE_INPUT_AMOUNT");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, EticaSwapLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, address(this));
        IWEGAZ(WEGAZ_TOKEN).withdraw(amounts[amounts.length - 1]);
        TransferHelper.safeTransferEGAZ(to, amounts[amounts.length - 1]);
    }

    function swapExactTokensForEGAZ(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    )
        external
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        require(path[path.length - 1] == WEGAZ_TOKEN, "ESwap: INVALID_PATH");
        amounts = EticaSwapLibrary.getAmountsOut(factory, amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "ESwap: INSUFFICIENT_OUTPUT_AMOUNT");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, EticaSwapLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, address(this));
        IWEGAZ(WEGAZ_TOKEN).withdraw(amounts[amounts.length - 1]);
        TransferHelper.safeTransferEGAZ(to, amounts[amounts.length - 1]);
    }

    function swapEGAZForExactTokens(
        uint256 amountOut,
        address[] calldata path,
        address to,
        uint256 deadline
    )
        external
        payable
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        require(path[0] == WEGAZ_TOKEN, "ESwap: INVALID_PATH");
        amounts = EticaSwapLibrary.getAmountsIn(factory, amountOut, path);
        require(amounts[0] <= msg.value, "ESwap: EXCESSIVE_INPUT_AMOUNT");
        IWEGAZ(WEGAZ_TOKEN).deposit{value: amounts[0]}();
        assert(
            IWEGAZ(WEGAZ_TOKEN).transfer(EticaSwapLibrary.pairFor(factory, path[0], path[1]), amounts[0])
        );
        _swap(amounts, path, to);
        if (msg.value > amounts[0]) TransferHelper.safeTransferEGAZ(msg.sender, msg.value - amounts[0]);
    }

    // ------------------------------------------------------------------ VIEWS

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB)
        external
        pure
        returns (uint256)
    {
        return EticaSwapLibrary.quote(amountA, reserveA, reserveB);
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        external
        pure
        returns (uint256)
    {
        return EticaSwapLibrary.getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        external
        pure
        returns (uint256)
    {
        return EticaSwapLibrary.getAmountIn(amountOut, reserveIn, reserveOut);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory)
    {
        return EticaSwapLibrary.getAmountsOut(factory, amountIn, path);
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external
        view
        returns (uint256[] memory)
    {
        return EticaSwapLibrary.getAmountsIn(factory, amountOut, path);
    }
}
