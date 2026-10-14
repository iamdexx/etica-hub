// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {IEticaSwapFactory} from "../swap/interfaces/IEticaSwapFactory.sol";
import {IEticaSwapPair} from "../swap/interfaces/IEticaSwapPair.sol";
import {IERC20Minimal} from "../swap/interfaces/IERC20Minimal.sol";
import {IWEGAZ} from "../swap/interfaces/IWEGAZ.sol";
import {IEticaDirectFactory} from "./IEticaDirectFactory.sol";
import {IEticaDirectPair} from "./IEticaDirectPair.sol";
import {EticaDirectLibrary} from "./EticaDirectLibrary.sol";
import {TransferHelper} from "../swap/libraries/TransferHelper.sol";

/// @title EticaSwap Direct router
/// @notice {EticaSwapRouter} for the stETX-gated direct venue. Every entry
///         point additionally requires the final recipient `to` to pass the
///         factory gate, because the pair only sees this router as `to` on
///         the EGAZ unwrap paths (swap*ForEGAZ, removeLiquidityEGAZ).
///         Supports ERC20/ERC20 and EGAZ/ERC20 pairs (EGAZ wrapped via WEGAZ).
contract EticaDirectRouter {
    address public immutable factory;
    address public immutable WEGAZ_TOKEN;

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "ESwap: EXPIRED");
        _;
    }

    /// @dev Final recipients must pass the stETX gate and must be a wallet or
    ///      external contract, never the router itself or a venue pair (tokens
    ///      sent there would be stranded or skimmable).
    modifier gated(address to) {
        _gate(to);
        _;
    }

    function _gate(address to) private view {
        IEticaDirectFactory fac = IEticaDirectFactory(factory);
        require(to != address(this) && !fac.isPair(to), "EDirect: INVALID_TO");
        require(fac.isAllowed(to), "EDirect: NOT_STAKER");
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
        IEticaSwapFactory fac = IEticaSwapFactory(factory);
        // Pairs on the direct venue are curated: the router never opens one.
        require(fac.getPair(tokenA, tokenB) != address(0), "EDirect: NO_PAIR");
        (uint256 reserveA, uint256 reserveB) = _reservesOrZero(tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = EticaDirectLibrary.quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                require(amountBOptimal >= amountBMin, "ESwap: INSUFFICIENT_B_AMOUNT");
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal =
                    EticaDirectLibrary.quote(amountBDesired, reserveB, reserveA);
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
        (address token0,) = EticaDirectLibrary.sortTokens(tokenA, tokenB);
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
        gated(to)
        returns (uint256 amountA, uint256 amountB, uint256 liquidity)
    {
        (amountA, amountB) = _addLiquidity(
            tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin
        );
        address pair = EticaDirectLibrary.pairFor(factory, tokenA, tokenB);
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
        gated(to)
        returns (uint256 amountToken, uint256 amountEGAZ, uint256 liquidity)
    {
        (amountToken, amountEGAZ) = _addLiquidity(
            token, WEGAZ_TOKEN, amountTokenDesired, msg.value, amountTokenMin, amountEGAZMin
        );
        address pair = EticaDirectLibrary.pairFor(factory, token, WEGAZ_TOKEN);
        TransferHelper.safeTransferFrom(token, msg.sender, pair, amountToken);
        IWEGAZ(WEGAZ_TOKEN).deposit{value: amountEGAZ}();
        assert(IWEGAZ(WEGAZ_TOKEN).transfer(pair, amountEGAZ));
        liquidity = IEticaSwapPair(pair).mint(to);
        if (msg.value > amountEGAZ) {
            TransferHelper.safeTransferEGAZ(msg.sender, msg.value - amountEGAZ);
        }
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
    ) public ensure(deadline) gated(to) returns (uint256 amountA, uint256 amountB) {
        return _removeLiquidity(tokenA, tokenB, liquidity, amountAMin, amountBMin, to);
    }

    function _removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to
    ) internal returns (uint256 amountA, uint256 amountB) {
        address pair = EticaDirectLibrary.pairFor(factory, tokenA, tokenB);
        IEticaSwapPair(pair).transferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = IEticaSwapPair(pair).burn(to);
        (address token0,) = EticaDirectLibrary.sortTokens(tokenA, tokenB);
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
    ) public ensure(deadline) gated(to) returns (uint256 amountToken, uint256 amountEGAZ) {
        (amountToken, amountEGAZ) = _removeLiquidity(
            token, WEGAZ_TOKEN, liquidity, amountTokenMin, amountEGAZMin, address(this)
        );
        TransferHelper.safeTransfer(token, to, amountToken);
        IWEGAZ(WEGAZ_TOKEN).withdraw(amountEGAZ);
        TransferHelper.safeTransferEGAZ(to, amountEGAZ);
    }

    // ------------------------------------------------------------------ SWAPS

    /// @dev Every router swap is priced at `msg.sender`'s stETX tier (the
    ///      wallet that signs the trade, so no one can be billed at another
    ///      wallet's discount) and `msg.sender` must pass the gate; `_to` may
    ///      be this router on the EGAZ unwrap paths.
    function _swap(uint256[] memory amounts, address[] memory path, address _to, address trader)
        internal
    {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = EticaDirectLibrary.sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) =
                input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address to = i < path.length - 2
                ? EticaDirectLibrary.pairFor(factory, output, path[i + 2])
                : _to;
            IEticaDirectPair(EticaDirectLibrary.pairFor(factory, input, output))
                .swapFor(amount0Out, amount1Out, to, trader, new bytes(0));
        }
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) gated(to) returns (uint256[] memory amounts) {
        amounts = EticaDirectLibrary.getAmountsOut(factory, amountIn, path, _fee(msg.sender));
        require(amounts[amounts.length - 1] >= amountOutMin, "ESwap: INSUFFICIENT_OUTPUT_AMOUNT");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, EticaDirectLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, to, msg.sender);
    }

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) gated(to) returns (uint256[] memory amounts) {
        amounts = EticaDirectLibrary.getAmountsIn(factory, amountOut, path, _fee(msg.sender));
        require(amounts[0] <= amountInMax, "ESwap: EXCESSIVE_INPUT_AMOUNT");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, EticaDirectLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, to, msg.sender);
    }

    function swapExactEGAZForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) gated(to) returns (uint256[] memory amounts) {
        require(path[0] == WEGAZ_TOKEN, "ESwap: INVALID_PATH");
        amounts = EticaDirectLibrary.getAmountsOut(factory, msg.value, path, _fee(msg.sender));
        require(amounts[amounts.length - 1] >= amountOutMin, "ESwap: INSUFFICIENT_OUTPUT_AMOUNT");
        IWEGAZ(WEGAZ_TOKEN).deposit{value: amounts[0]}();
        assert(
            IWEGAZ(WEGAZ_TOKEN)
                .transfer(EticaDirectLibrary.pairFor(factory, path[0], path[1]), amounts[0])
        );
        _swap(amounts, path, to, msg.sender);
    }

    function swapTokensForExactEGAZ(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) gated(to) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == WEGAZ_TOKEN, "ESwap: INVALID_PATH");
        amounts = EticaDirectLibrary.getAmountsIn(factory, amountOut, path, _fee(msg.sender));
        require(amounts[0] <= amountInMax, "ESwap: EXCESSIVE_INPUT_AMOUNT");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, EticaDirectLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, address(this), msg.sender);
        IWEGAZ(WEGAZ_TOKEN).withdraw(amounts[amounts.length - 1]);
        TransferHelper.safeTransferEGAZ(to, amounts[amounts.length - 1]);
    }

    function swapExactTokensForEGAZ(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) gated(to) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == WEGAZ_TOKEN, "ESwap: INVALID_PATH");
        amounts = EticaDirectLibrary.getAmountsOut(factory, amountIn, path, _fee(msg.sender));
        require(amounts[amounts.length - 1] >= amountOutMin, "ESwap: INSUFFICIENT_OUTPUT_AMOUNT");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, EticaDirectLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, address(this), msg.sender);
        IWEGAZ(WEGAZ_TOKEN).withdraw(amounts[amounts.length - 1]);
        TransferHelper.safeTransferEGAZ(to, amounts[amounts.length - 1]);
    }

    function swapEGAZForExactTokens(
        uint256 amountOut,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) gated(to) returns (uint256[] memory amounts) {
        require(path[0] == WEGAZ_TOKEN, "ESwap: INVALID_PATH");
        amounts = EticaDirectLibrary.getAmountsIn(factory, amountOut, path, _fee(msg.sender));
        require(amounts[0] <= msg.value, "ESwap: EXCESSIVE_INPUT_AMOUNT");
        IWEGAZ(WEGAZ_TOKEN).deposit{value: amounts[0]}();
        assert(
            IWEGAZ(WEGAZ_TOKEN)
                .transfer(EticaDirectLibrary.pairFor(factory, path[0], path[1]), amounts[0])
        );
        _swap(amounts, path, to, msg.sender);
        if (msg.value > amounts[0]) {
            TransferHelper.safeTransferEGAZ(msg.sender, msg.value - amounts[0]);
        }
    }

    // ------------------------------------------------------------------ VIEWS

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB)
        external
        pure
        returns (uint256)
    {
        return EticaDirectLibrary.quote(amountA, reserveA, reserveB);
    }

    function _fee(address trader) private view returns (uint256) {
        return IEticaDirectFactory(factory).feeBpsFor(trader);
    }

    /// @notice Fee (bps of input) `trader` currently pays on this venue.
    function feeBpsFor(address trader) external view returns (uint16) {
        return IEticaDirectFactory(factory).feeBpsFor(trader);
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        external
        pure
        returns (uint256)
    {
        return EticaDirectLibrary.getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        external
        pure
        returns (uint256)
    {
        return EticaDirectLibrary.getAmountIn(amountOut, reserveIn, reserveOut, feeBps);
    }

    /// @notice Quote as if `trader` signed the swap (its stETX tier sets the fee).
    function getAmountsOut(uint256 amountIn, address[] calldata path, address trader)
        external
        view
        returns (uint256[] memory)
    {
        return EticaDirectLibrary.getAmountsOut(factory, amountIn, path, _fee(trader));
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path, address trader)
        external
        view
        returns (uint256[] memory)
    {
        return EticaDirectLibrary.getAmountsIn(factory, amountOut, path, _fee(trader));
    }

    /// @notice V2-shaped quote; priced for `msg.sender` (eth_call `from`),
    ///         exactly as the swap entry points charge.
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory)
    {
        return EticaDirectLibrary.getAmountsOut(factory, amountIn, path, _fee(msg.sender));
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external
        view
        returns (uint256[] memory)
    {
        return EticaDirectLibrary.getAmountsIn(factory, amountOut, path, _fee(msg.sender));
    }
}
