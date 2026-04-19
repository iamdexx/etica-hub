// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ETXToken} from "../../src/etx/ETXToken.sol";

contract ETXTokenTest is Test {
    ETXToken internal etx;
    address internal constant DISTRIBUTOR = address(0xA11CE);

    function setUp() public {
        etx = new ETXToken(DISTRIBUTOR);
    }

    function test_metadata() public view {
        assertEq(etx.name(), "EticaHub Token");
        assertEq(etx.symbol(), "ETX");
        assertEq(etx.decimals(), 18);
    }

    function test_mintsMaxSupplyToDistributor() public view {
        assertEq(etx.totalSupply(), 100_000_000 * 1e18);
        assertEq(etx.balanceOf(DISTRIBUTOR), 100_000_000 * 1e18);
    }

    function test_revertsOnZeroDistributor() public {
        vm.expectRevert(bytes("ETX: zero distributor"));
        new ETXToken(address(0));
    }
}
