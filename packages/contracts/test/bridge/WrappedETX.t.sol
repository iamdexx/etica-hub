// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {WrappedETX} from "../../src/bridge/WrappedETX.sol";

contract WrappedETXTest is Test {
    WrappedETX internal wetx;

    address internal constant MINTER = address(0xB81D6E);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    uint256 internal constant ONE = 1e18;

    function setUp() public {
        wetx = new WrappedETX(MINTER);
    }

    /* -------------------------------------------------------------------- */
    /*                              METADATA                                */
    /* -------------------------------------------------------------------- */

    function test_metadata_nameSymbolDecimals() public view {
        assertEq(wetx.name(), "Wrapped ETX");
        assertEq(wetx.symbol(), "wETX");
        assertEq(wetx.decimals(), 18);
    }

    function test_metadata_minterIsImmutable() public view {
        assertEq(wetx.bridgeMinter(), MINTER);
    }

    /* -------------------------------------------------------------------- */
    /*                            CONSTRUCTOR                               */
    /* -------------------------------------------------------------------- */

    function test_constructor_revertsOnZeroMinter() public {
        vm.expectRevert(WrappedETX.WrappedETX_ZeroAddress.selector);
        new WrappedETX(address(0));
    }

    /* -------------------------------------------------------------------- */
    /*                                MINT                                  */
    /* -------------------------------------------------------------------- */

    function test_mint_succeedsForMinter() public {
        vm.prank(MINTER);
        wetx.mint(ALICE, 1000 * ONE);

        assertEq(wetx.balanceOf(ALICE), 1000 * ONE);
        assertEq(wetx.totalSupply(), 1000 * ONE);
    }

    function test_mint_revertsOnNonMinter() public {
        vm.expectRevert(
            abi.encodeWithSelector(WrappedETX.WrappedETX_OnlyBridgeMinter.selector, ALICE)
        );
        vm.prank(ALICE);
        wetx.mint(ALICE, 1000 * ONE);
    }

    function test_mint_revertsOnNonMinter_evenWhenContract() public {
        vm.expectRevert(
            abi.encodeWithSelector(WrappedETX.WrappedETX_OnlyBridgeMinter.selector, address(this))
        );
        wetx.mint(ALICE, 1000 * ONE);
    }

    function testFuzz_mint_acceptsAnyAmountForMinter(uint128 amount) public {
        vm.prank(MINTER);
        wetx.mint(ALICE, amount);
        assertEq(wetx.balanceOf(ALICE), amount);
    }

    /* -------------------------------------------------------------------- */
    /*                                BURN                                  */
    /* -------------------------------------------------------------------- */

    function test_burn_succeedsForMinter() public {
        vm.prank(MINTER);
        wetx.mint(ALICE, 1000 * ONE);

        vm.prank(MINTER);
        wetx.burn(ALICE, 400 * ONE);

        assertEq(wetx.balanceOf(ALICE), 600 * ONE);
        assertEq(wetx.totalSupply(), 600 * ONE);
    }

    function test_burn_revertsOnNonMinter() public {
        vm.prank(MINTER);
        wetx.mint(ALICE, 1000 * ONE);

        vm.expectRevert(
            abi.encodeWithSelector(WrappedETX.WrappedETX_OnlyBridgeMinter.selector, ALICE)
        );
        vm.prank(ALICE);
        wetx.burn(ALICE, 100 * ONE);
    }

    function test_burn_revertsOnInsufficientBalance() public {
        vm.prank(MINTER);
        wetx.mint(ALICE, 100 * ONE);

        // OZ ERC20 reverts with ERC20InsufficientBalance(sender, balance, needed)
        vm.expectRevert();
        vm.prank(MINTER);
        wetx.burn(ALICE, 200 * ONE);
    }

    /* -------------------------------------------------------------------- */
    /*                              TRANSFER                                */
    /* -------------------------------------------------------------------- */

    function test_transfer_worksNormally() public {
        vm.prank(MINTER);
        wetx.mint(ALICE, 1000 * ONE);

        vm.prank(ALICE);
        wetx.transfer(BOB, 250 * ONE);

        assertEq(wetx.balanceOf(ALICE), 750 * ONE);
        assertEq(wetx.balanceOf(BOB), 250 * ONE);
    }

    function test_approveAndTransferFrom_worksNormally() public {
        vm.prank(MINTER);
        wetx.mint(ALICE, 1000 * ONE);

        vm.prank(ALICE);
        wetx.approve(BOB, 300 * ONE);

        vm.prank(BOB);
        wetx.transferFrom(ALICE, BOB, 300 * ONE);

        assertEq(wetx.balanceOf(ALICE), 700 * ONE);
        assertEq(wetx.balanceOf(BOB), 300 * ONE);
        assertEq(wetx.allowance(ALICE, BOB), 0);
    }

    /* -------------------------------------------------------------------- */
    /*                              PERMIT                                  */
    /* -------------------------------------------------------------------- */

    function test_permit_setsAllowance() public {
        uint256 alicePk = 0xA11CE;
        address aliceAddr = vm.addr(alicePk);

        vm.prank(MINTER);
        wetx.mint(aliceAddr, 1000 * ONE);

        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = wetx.nonces(aliceAddr);

        bytes32 domainSeparator = wetx.DOMAIN_SEPARATOR();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                aliceAddr,
                BOB,
                500 * ONE,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

        wetx.permit(aliceAddr, BOB, 500 * ONE, deadline, v, r, s);

        assertEq(wetx.allowance(aliceAddr, BOB), 500 * ONE);
        assertEq(wetx.nonces(aliceAddr), nonce + 1);
    }
}
