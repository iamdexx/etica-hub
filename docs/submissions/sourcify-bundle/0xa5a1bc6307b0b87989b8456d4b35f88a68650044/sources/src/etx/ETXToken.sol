// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title ETX — EticaHub governance/reward token
/// @notice Fixed supply of 100,000,000 ETX minted once at deploy time.
///         No further minting is possible.
contract ETXToken is ERC20Permit {
    uint256 public constant MAX_SUPPLY = 100_000_000 * 1e18;

    constructor(address distributor) ERC20("EticaHub", "ETX") ERC20Permit("EticaHub") {
        require(distributor != address(0), "ETX: zero distributor");
        _mint(distributor, MAX_SUPPLY);
    }
}
