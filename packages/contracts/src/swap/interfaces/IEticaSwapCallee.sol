// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

/// @title Flash-swap callback.
/// @notice Contracts receiving flash swaps from a pair must implement this.
interface IEticaSwapCallee {
    function eticaSwapCall(address sender, uint256 amount0, uint256 amount1, bytes calldata data)
        external;
}
