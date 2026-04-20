// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

/// @title UQ112x112 fixed-point
/// @notice Represents a range [0, 2^112 - 1] with a resolution of 1 / 2^112.
/// @dev Ported from Uniswap V2 core. Range-safe for reserves stored as uint112.
library UQ112x112 {
    uint224 internal constant Q112 = 2 ** 112;

    function encode(uint112 y) internal pure returns (uint224 z) {
        z = uint224(y) * Q112;
    }

    function uqdiv(uint224 x, uint112 y) internal pure returns (uint224 z) {
        z = x / uint224(y);
    }
}
