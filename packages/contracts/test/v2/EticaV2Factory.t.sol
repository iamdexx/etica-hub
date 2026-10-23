// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EticaV2Factory} from "../../src/v2/EticaV2Factory.sol";
import {EticaSwapPair} from "../../src/swap/EticaSwapPair.sol";
import {IEticaSwapPair} from "../../src/swap/interfaces/IEticaSwapPair.sol";
import {EticaSwapRouter} from "../../src/swap/EticaSwapRouter.sol";
import {WEGAZ} from "../../src/swap/WEGAZ.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract EticaV2FactoryTest is Test {
    address constant FEE_SETTER = address(0xFEE);
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    EticaV2Factory factory;
    EticaSwapRouter router;
    WEGAZ wegaz;
    MockERC20 usdc;
    MockERC20 eti;

    function setUp() public {
        wegaz = new WEGAZ();
        usdc = new MockERC20("USDC.e", "USDC.e");
        eti = new MockERC20("Etica", "ETI");
        factory = new EticaV2Factory(FEE_SETTER);
        router = new EticaSwapRouter(address(factory), address(wegaz));

        usdc.mint(ALICE, 1_000_000 ether);
        eti.mint(ALICE, 1_000_000 ether);
        usdc.mint(BOB, 1_000 ether);
        vm.deal(ALICE, 1_000_000 ether);
        vm.deal(BOB, 1_000 ether);
        vm.startPrank(ALICE);
        usdc.approve(address(router), type(uint256).max);
        eti.approve(address(router), type(uint256).max);
        vm.stopPrank();
        vm.prank(BOB);
        usdc.approve(address(router), type(uint256).max);
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(bytes("EV2: ZERO_ADDRESS"));
        new EticaV2Factory(address(0));
    }

    function test_createPair_isOpenToAnyone() public {
        vm.prank(ALICE);
        address pair = factory.createPair(address(usdc), address(wegaz));
        assertTrue(pair != address(0));
        assertEq(factory.allPairsLength(), 1);
        assertEq(factory.allPairs(0), pair);
        assertEq(factory.getPair(address(wegaz), address(usdc)), pair);
        (address t0, address t1) = address(usdc) < address(wegaz)
            ? (address(usdc), address(wegaz))
            : (address(wegaz), address(usdc));
        assertEq(IEticaSwapPair(pair).token0(), t0);
        assertEq(IEticaSwapPair(pair).token1(), t1);
        assertEq(IEticaSwapPair(pair).factory(), address(factory));
    }

    function test_createPair_rejectsIdenticalAndZero() public {
        vm.expectRevert(bytes("EV2: IDENTICAL_ADDRESSES"));
        factory.createPair(address(usdc), address(usdc));
        vm.expectRevert(bytes("EV2: ZERO_ADDRESS"));
        factory.createPair(address(0), address(usdc));
    }

    function test_createPair_revertsOnDuplicate() public {
        factory.createPair(address(usdc), address(eti));
        vm.expectRevert(bytes("EV2: PAIR_EXISTS"));
        factory.createPair(address(eti), address(usdc));
    }

    function test_pairCodeHash_matchesDeployedPair() public {
        (address t0, address t1) = address(usdc) < address(eti)
            ? (address(usdc), address(eti))
            : (address(eti), address(usdc));
        address predicted = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff",
                            address(factory),
                            keccak256(abi.encodePacked(t0, t1)),
                            factory.pairCodeHash()
                        )
                    )
                )
            )
        );
        address pair = factory.createPair(address(usdc), address(eti));
        assertEq(pair, predicted);
    }

    function test_setters_onlyFeeToSetter() public {
        vm.prank(ALICE);
        vm.expectRevert(bytes("EV2: FORBIDDEN"));
        factory.setFeeTo(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(bytes("EV2: FORBIDDEN"));
        factory.setFeeToSetter(ALICE);

        vm.prank(FEE_SETTER);
        vm.expectRevert(bytes("EV2: ZERO_ADDRESS"));
        factory.setFeeToSetter(address(0));

        vm.startPrank(FEE_SETTER);
        factory.setFeeTo(BOB);
        assertEq(factory.feeTo(), BOB);
        factory.setFeeToSetter(ALICE);
        assertEq(factory.feeToSetter(), ALICE);
        vm.stopPrank();
    }

    function test_router_addLiquidityAndSwap_egazUsdc() public {
        address pair = factory.createPair(address(usdc), address(wegaz));

        vm.prank(ALICE);
        router.addLiquidityEGAZ{value: 100_000 ether}(
            address(usdc), 100 ether, 0, 0, ALICE, block.timestamp + 1
        );
        assertGt(IEticaSwapPair(pair).balanceOf(ALICE), 0);
        assertEq(usdc.balanceOf(pair), 100 ether);
        assertEq(wegaz.balanceOf(pair), 100_000 ether);

        address[] memory path = new address[](2);
        path[0] = address(usdc);
        path[1] = address(wegaz);
        uint256 before = BOB.balance;
        vm.prank(BOB);
        router.swapExactTokensForEGAZ(1 ether, 0, path, BOB, block.timestamp + 1);
        uint256 got = BOB.balance - before;
        assertGt(got, 980 ether);
        assertLt(got, 1_000 ether);
        assertEq(usdc.balanceOf(pair), 101 ether);
    }

    function test_router_addLiquidity_etiUsdc() public {
        address pair = factory.createPair(address(usdc), address(eti));
        vm.prank(ALICE);
        router.addLiquidity(
            address(usdc), address(eti), 50 ether, 5_000 ether, 0, 0, ALICE, block.timestamp + 1
        );
        (uint112 r0, uint112 r1,) = IEticaSwapPair(pair).getReserves();
        assertEq(uint256(r0) + uint256(r1), 5_050 ether);
        assertEq(usdc.balanceOf(pair), 50 ether);
        assertEq(eti.balanceOf(pair), 5_000 ether);
    }
}
