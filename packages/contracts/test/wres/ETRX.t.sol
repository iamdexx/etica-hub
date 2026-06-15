// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ETRX} from "../../src/wres/ETRX.sol";

contract ETRXTest is Test {
    ETRX internal etrx;

    address internal constant MINTER = address(0xB1D6E);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    uint256 internal constant ONE = 1e18;

    function setUp() public {
        etrx = new ETRX(MINTER);
    }

    function testMetadata() public view {
        assertEq(etrx.name(), "Etica Wrapped TRX", "name");
        assertEq(etrx.symbol(), "eTRX", "symbol");
        assertEq(etrx.bridgeMinter(), MINTER, "minter");
    }

    function testConstructorRejectsZeroMinter() public {
        vm.expectRevert(ETRX.ETRX_ZeroAddress.selector);
        new ETRX(address(0));
    }

    function testOnlyMinterCanMint() public {
        vm.expectRevert(abi.encodeWithSelector(ETRX.ETRX_OnlyBridgeMinter.selector, BOB));
        vm.prank(BOB);
        etrx.mint(ALICE, ONE);
    }

    function testMintAndBurnByMinter() public {
        vm.prank(MINTER);
        etrx.mint(ALICE, 100 * ONE);
        assertEq(etrx.balanceOf(ALICE), 100 * ONE, "minted");
        assertEq(etrx.totalSupply(), 100 * ONE, "supply tracks backing");

        vm.prank(MINTER);
        etrx.burn(ALICE, 40 * ONE);
        assertEq(etrx.balanceOf(ALICE), 60 * ONE, "burned");
        assertEq(etrx.totalSupply(), 60 * ONE, "supply reduced 1:1");
    }

    function testOnlyMinterCanBurn() public {
        vm.prank(MINTER);
        etrx.mint(ALICE, ONE);
        vm.expectRevert(abi.encodeWithSelector(ETRX.ETRX_OnlyBridgeMinter.selector, ALICE));
        vm.prank(ALICE);
        etrx.burn(ALICE, ONE);
    }

    function testPermitTypehashAvailable() public view {
        // ERC20Permit wiring is intact (eTRX slots into existing bridge tooling).
        assertTrue(etrx.DOMAIN_SEPARATOR() != bytes32(0), "domain separator");
    }
}
