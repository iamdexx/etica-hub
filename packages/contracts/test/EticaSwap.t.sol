// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EticaSwapFactory} from "../src/swap/EticaSwapFactory.sol";
import {EticaSwapPair} from "../src/swap/EticaSwapPair.sol";
import {EticaSwapRouter} from "../src/swap/EticaSwapRouter.sol";
import {WEGAZ} from "../src/swap/WEGAZ.sol";
import {IEticaSwapPair} from "../src/swap/interfaces/IEticaSwapPair.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract EticaSwapTest is Test {
    address internal constant FEE_SETTER = address(0xFEE5E77E8);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    EticaSwapFactory internal factory;
    EticaSwapRouter internal router;
    WEGAZ internal wegaz;
    MockERC20 internal eti;
    MockERC20 internal usdt;

    function setUp() public {
        factory = new EticaSwapFactory(FEE_SETTER);
        wegaz = new WEGAZ();
        router = new EticaSwapRouter(address(factory), address(wegaz));

        eti = new MockERC20("Etica (mock)", "ETI");
        usdt = new MockERC20("USDT (mock)", "USDT");

        eti.mint(ALICE, 1_000_000 ether);
        usdt.mint(ALICE, 1_000_000 ether);
        vm.deal(ALICE, 1_000 ether);

        eti.mint(BOB, 1_000_000 ether);
        usdt.mint(BOB, 1_000_000 ether);
        vm.deal(BOB, 1_000 ether);
    }

    function _approveRouterFor(address user) internal {
        vm.startPrank(user);
        eti.approve(address(router), type(uint256).max);
        usdt.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    // ---------- factory ----------

    function test_factory_createPair_sortsAndTracks() public {
        address pair = factory.createPair(address(eti), address(usdt));
        assertEq(factory.allPairsLength(), 1);
        assertEq(factory.allPairs(0), pair);
        assertEq(factory.getPair(address(eti), address(usdt)), pair);
        assertEq(factory.getPair(address(usdt), address(eti)), pair);
    }

    function test_factory_createPair_revertsOnDuplicate() public {
        factory.createPair(address(eti), address(usdt));
        vm.expectRevert(bytes("ESwap: PAIR_EXISTS"));
        factory.createPair(address(eti), address(usdt));
    }

    function test_factory_createPair_revertsOnIdentical() public {
        vm.expectRevert(bytes("ESwap: IDENTICAL_ADDRESSES"));
        factory.createPair(address(eti), address(eti));
    }

    // ---------- pair math via router ----------

    function test_router_addLiquidity_mintsLpTokensAndReserves() public {
        _approveRouterFor(ALICE);

        vm.prank(ALICE);
        (uint256 amountA, uint256 amountB, uint256 liq) = router.addLiquidity(
            address(eti),
            address(usdt),
            10_000 ether,
            20_000 ether,
            0,
            0,
            ALICE,
            block.timestamp + 1
        );
        assertEq(amountA, 10_000 ether);
        assertEq(amountB, 20_000 ether);
        assertGt(liq, 0);

        address pair = factory.getPair(address(eti), address(usdt));
        (uint112 r0, uint112 r1,) = IEticaSwapPair(pair).getReserves();
        assertTrue((r0 > 0) && (r1 > 0));
        assertEq(IEticaSwapPair(pair).balanceOf(ALICE), liq);
    }

    function test_router_swapExactTokensForTokens_respectsFee() public {
        _approveRouterFor(ALICE);
        _approveRouterFor(BOB);

        vm.prank(ALICE);
        router.addLiquidity(
            address(eti),
            address(usdt),
            100_000 ether,
            100_000 ether,
            0,
            0,
            ALICE,
            block.timestamp + 1
        );

        uint256 bobUsdtBefore = usdt.balanceOf(BOB);
        uint256 amountIn = 1_000 ether;

        address[] memory path = new address[](2);
        path[0] = address(eti);
        path[1] = address(usdt);

        uint256[] memory expected = router.getAmountsOut(amountIn, path);

        vm.prank(BOB);
        uint256[] memory amounts =
            router.swapExactTokensForTokens(amountIn, 0, path, BOB, block.timestamp + 1);

        assertEq(amounts[1], expected[1]);
        assertEq(usdt.balanceOf(BOB) - bobUsdtBefore, expected[1]);
        // 0.30% fee on 1000 in 1:1 pool ≈ gets <997 units out (not 1000)
        assertLt(expected[1], 1_000 ether);
        assertGt(expected[1], 900 ether);
    }

    function test_router_removeLiquidity_burnsAndReturns() public {
        _approveRouterFor(ALICE);
        vm.prank(ALICE);
        (, , uint256 liq) = router.addLiquidity(
            address(eti),
            address(usdt),
            10_000 ether,
            10_000 ether,
            0,
            0,
            ALICE,
            block.timestamp + 1
        );

        address pair = factory.getPair(address(eti), address(usdt));
        vm.prank(ALICE);
        IEticaSwapPair(pair).approve(address(router), liq);

        uint256 etiBefore = eti.balanceOf(ALICE);
        uint256 usdtBefore = usdt.balanceOf(ALICE);

        vm.prank(ALICE);
        (uint256 aOut, uint256 bOut) = router.removeLiquidity(
            address(eti), address(usdt), liq, 0, 0, ALICE, block.timestamp + 1
        );

        assertGt(aOut, 0);
        assertGt(bOut, 0);
        assertEq(eti.balanceOf(ALICE) - etiBefore, aOut);
        assertEq(usdt.balanceOf(ALICE) - usdtBefore, bOut);
    }

    // ---------- WEGAZ + EGAZ swaps ----------

    function test_wegaz_depositAndWithdraw() public {
        vm.startPrank(ALICE);
        wegaz.deposit{value: 5 ether}();
        assertEq(wegaz.balanceOf(ALICE), 5 ether);
        wegaz.withdraw(2 ether);
        assertEq(wegaz.balanceOf(ALICE), 3 ether);
        vm.stopPrank();
    }

    function test_router_addLiquidityEGAZ_and_swapExactEGAZForTokens() public {
        _approveRouterFor(ALICE);

        vm.prank(ALICE);
        router.addLiquidityEGAZ{value: 100 ether}(
            address(eti),
            100_000 ether,
            0,
            0,
            ALICE,
            block.timestamp + 1
        );

        address[] memory path = new address[](2);
        path[0] = address(wegaz);
        path[1] = address(eti);

        uint256 bobEtiBefore = eti.balanceOf(BOB);

        vm.prank(BOB);
        router.swapExactEGAZForTokens{value: 1 ether}(0, path, BOB, block.timestamp + 1);

        assertGt(eti.balanceOf(BOB) - bobEtiBefore, 0);
    }

    // ---------- fee on / off ----------

    function test_protocolFee_onlyAccruesWhenEnabled() public {
        _approveRouterFor(ALICE);
        _approveRouterFor(BOB);

        vm.prank(FEE_SETTER);
        factory.setFeeTo(address(0xCAFE));

        vm.prank(ALICE);
        router.addLiquidity(
            address(eti),
            address(usdt),
            100_000 ether,
            100_000 ether,
            0,
            0,
            ALICE,
            block.timestamp + 1
        );

        address pair = factory.getPair(address(eti), address(usdt));

        // Do a bunch of swaps back and forth to grow k.
        for (uint256 i; i < 5; i++) {
            address[] memory p0 = new address[](2);
            p0[0] = address(eti);
            p0[1] = address(usdt);
            vm.prank(BOB);
            router.swapExactTokensForTokens(500 ether, 0, p0, BOB, block.timestamp + 1);

            address[] memory p1 = new address[](2);
            p1[0] = address(usdt);
            p1[1] = address(eti);
            vm.prank(BOB);
            router.swapExactTokensForTokens(500 ether, 0, p1, BOB, block.timestamp + 1);
        }

        // Trigger fee mint via another add/remove liquidity.
        vm.prank(ALICE);
        router.addLiquidity(
            address(eti),
            address(usdt),
            1 ether,
            1 ether,
            0,
            0,
            ALICE,
            block.timestamp + 1
        );

        assertGt(IEticaSwapPair(pair).balanceOf(address(0xCAFE)), 0);
    }
}
