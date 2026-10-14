// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

/// @title EticaSwap Direct pair — venue-specific surface on top of the V2 pair ABI
interface IEticaDirectPair {
    /// @notice Swap priced at `trader`'s stETX fee tier; whitelisted routers only.
    function swapFor(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        address trader,
        bytes calldata data
    ) external;
}
