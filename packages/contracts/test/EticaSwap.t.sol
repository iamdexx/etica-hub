// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EticaSwapFactory} from "../src/swap/EticaSwapFactory.sol";
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
    MockERC20 internal etx;
    MockERC20 internal eti;
    MockERC20 internal usdt;

    function setUp() public {
        etx = new MockERC20("ETX (mock)", "ETX");
        factory = new EticaSwapFactory(FEE_SETTER, address(etx));
        wegaz = new WEGAZ();
        router = new EticaSwapRouter(address(factory), address(wegaz));

        eti = new MockERC20("Etica (mock)", "ETI");
        usdt = new MockERC20("USDT (mock)", "USDT");

        etx.mint(ALICE, 10_000_000 ether);
        eti.mint(ALICE, 1_000_000 ether);
        usdt.mint(ALICE, 1_000_000 ether);
        vm.deal(ALICE, 1_000 ether);

        etx.mint(BOB, 10_000_000 ether);
        eti.mint(BOB, 1_000_000 ether);
        usdt.mint(BOB, 1_000_000 ether);
        vm.deal(BOB, 1_000 ether);
    }

    function _approveRouterFor(address user) internal {
        vm.startPrank(user);
        etx.approve(address(router), type(uint256).max);
        eti.approve(address(router), type(uint256).max);
        usdt.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    // ---------- factory ----------

    function test_factory_etxIsSet() public view {
        assertEq(factory.etx(), address(etx));
    }

    function test_factory_constructor_revertsOnZeroETX() public {
        vm.expectRevert(bytes("ESwap: ETX_ZERO_ADDRESS"));
        new EticaSwapFactory(FEE_SETTER, address(0));
    }

    function test_factory_createPair_sortsAndTracks() public {
        address pair = factory.createPair(address(eti), address(etx));
        assertEq(factory.allPairsLength(), 1);
        assertEq(factory.allPairs(0), pair);
        assertEq(factory.getPair(address(eti), address(etx)), pair);
        assertEq(factory.getPair(address(etx), address(eti)), pair);
    }

    function test_factory_createPair_revertsOnDuplicate() public {
        factory.createPair(address(eti), address(etx));
        vm.expectRevert(bytes("ESwap: PAIR_EXISTS"));
        factory.createPair(address(eti), address(etx));
    }

    function test_factory_createPair_revertsOnIdentical() public {
        vm.expectRevert(bytes("ESwap: IDENTICAL_ADDRESSES"));
        factory.createPair(address(etx), address(etx));
    }

    function test_factory_createPair_revertsWithoutETX() public {
        // Hub-and-spoke enforcement: ETI/USDT must go through ETX.
        vm.expectRevert(bytes("ESwap: MUST_PAIR_WITH_ETX"));
        factory.createPair(address(eti), address(usdt));
    }

    function test_factory_trustedCreator_canBypassHubRule() public {
        // Any caller not in the trustedCreators set is forced onto the ETX
        // hub; a trusted caller (e.g. the proposal-token launchpad) may open
        // non-ETX pairs directly so it can seed `token/ETI` pools.
        vm.prank(FEE_SETTER);
        factory.setTrustedCreator(BOB, true);

        vm.prank(BOB);
        address pair = factory.createPair(address(eti), address(usdt));
        assertTrue(pair != address(0));
        assertEq(factory.getPair(address(eti), address(usdt)), pair);

        vm.prank(ALICE);
        vm.expectRevert(bytes("ESwap: MUST_PAIR_WITH_ETX"));
        factory.createPair(address(usdt), address(eti));
    }

    function test_factory_setTrustedCreator_onlyFeeToSetter() public {
        vm.prank(ALICE);
        vm.expectRevert(bytes("ESwap: FORBIDDEN"));
        factory.setTrustedCreator(BOB, true);
    }

    function test_factory_setTrustedCreator_rejectsZero() public {
        vm.prank(FEE_SETTER);
        vm.expectRevert(bytes("ESwap: ZERO_ADDRESS"));
        factory.setTrustedCreator(address(0), true);
    }

    function test_factory_setTrustedCreator_canRevoke() public {
        vm.startPrank(FEE_SETTER);
        factory.setTrustedCreator(BOB, true);
        factory.setTrustedCreator(BOB, false);
        vm.stopPrank();

        vm.prank(BOB);
        vm.expectRevert(bytes("ESwap: MUST_PAIR_WITH_ETX"));
        factory.createPair(address(eti), address(usdt));
    }

    // ---------- pair creation fee ----------

    function test_factory_pairCreationFee_defaultIs10kETX() public view {
        assertEq(factory.pairCreationFee(), 10_000 ether);
    }

    function test_factory_createPair_skipsFeeWhenFeeToUnset() public {
        // Before the treasury is wired via setFeeTo, the fee is skipped so
        // the factory can bootstrap. Alice pays nothing and keeps her ETX.
        uint256 before = etx.balanceOf(ALICE);
        vm.prank(ALICE);
        factory.createPair(address(etx), address(eti));
        assertEq(etx.balanceOf(ALICE), before, "alice charged despite feeTo unset");
    }

    function test_factory_createPair_chargesFeeWhenFeeToSet() public {
        vm.prank(FEE_SETTER);
        factory.setFeeTo(FEE_SETTER);

        uint256 before = etx.balanceOf(ALICE);
        uint256 treasuryBefore = etx.balanceOf(FEE_SETTER);

        vm.startPrank(ALICE);
        etx.approve(address(factory), type(uint256).max);
        factory.createPair(address(etx), address(eti));
        vm.stopPrank();

        assertEq(etx.balanceOf(ALICE), before - 10_000 ether, "alice not charged");
        assertEq(etx.balanceOf(FEE_SETTER), treasuryBefore + 10_000 ether, "treasury not paid");
    }

    function test_factory_createPair_revertsWithoutETXApproval() public {
        vm.prank(FEE_SETTER);
        factory.setFeeTo(FEE_SETTER);

        vm.prank(ALICE);
        vm.expectRevert(bytes("TH: TRANSFER_FROM_FAILED"));
        factory.createPair(address(etx), address(eti));
    }

    function test_factory_createPair_trustedCreatorExemptFromFee() public {
        vm.startPrank(FEE_SETTER);
        factory.setFeeTo(FEE_SETTER);
        factory.setTrustedCreator(BOB, true);
        vm.stopPrank();

        uint256 before = etx.balanceOf(BOB);
        vm.prank(BOB);
        factory.createPair(address(eti), address(usdt));
        assertEq(etx.balanceOf(BOB), before, "trusted creator should not be charged");
    }

    function test_factory_setPairCreationFee_onlyFeeToSetter() public {
        vm.prank(ALICE);
        vm.expectRevert(bytes("ESwap: FORBIDDEN"));
        factory.setPairCreationFee(1 ether);
    }

    function test_factory_setPairCreationFee_zeroDisablesFee() public {
        vm.startPrank(FEE_SETTER);
        factory.setFeeTo(FEE_SETTER);
        factory.setPairCreationFee(0);
        vm.stopPrank();

        // No approval needed when fee is zero.
        uint256 before = etx.balanceOf(ALICE);
        vm.prank(ALICE);
        factory.createPair(address(etx), address(eti));
        assertEq(etx.balanceOf(ALICE), before, "charged despite zero fee");
    }

    function test_router_addLiquidity_forwardsPairCreationFee() public {
        vm.prank(FEE_SETTER);
        factory.setFeeTo(FEE_SETTER);

        // Alice approves the router for the LP amounts AND the 10k ETX fee.
        // The router pulls the fee from Alice on first-time pair creation and
        // forwards it to the factory in the same tx.
        _approveRouterFor(ALICE);

        uint256 aliceBefore = etx.balanceOf(ALICE);
        uint256 treasuryBefore = etx.balanceOf(FEE_SETTER);

        vm.prank(ALICE);
        router.addLiquidity(
            address(etx), address(eti), 1_000 ether, 1_000 ether, 0, 0, ALICE, block.timestamp + 1
        );

        // Alice paid 1,000 ETX LP + 10,000 ETX fee = 11,000 ETX net.
        assertEq(etx.balanceOf(ALICE), aliceBefore - 11_000 ether, "alice LP+fee accounting");
        assertEq(etx.balanceOf(FEE_SETTER), treasuryBefore + 10_000 ether, "treasury fee accrual");
    }

    function test_factory_createPair_acceptsEitherSide() public {
        address p1 = factory.createPair(address(etx), address(eti));
        address p2 = factory.createPair(address(usdt), address(etx));
        assertTrue(p1 != address(0));
        assertTrue(p2 != address(0));
        assertTrue(p1 != p2);
    }

    // ---------- pair math via router ----------

    function test_router_addLiquidity_mintsLpTokensAndReserves() public {
        _approveRouterFor(ALICE);

        vm.prank(ALICE);
        (uint256 amountA, uint256 amountB, uint256 liq) = router.addLiquidity(
            address(eti), address(etx), 10_000 ether, 20_000 ether, 0, 0, ALICE, block.timestamp + 1
        );
        assertEq(amountA, 10_000 ether);
        assertEq(amountB, 20_000 ether);
        assertGt(liq, 0);

        address pair = factory.getPair(address(eti), address(etx));
        (uint112 r0, uint112 r1,) = IEticaSwapPair(pair).getReserves();
        assertTrue((r0 > 0) && (r1 > 0));
        assertEq(IEticaSwapPair(pair).balanceOf(ALICE), liq);
    }

    function test_router_addLiquidity_revertsWithoutETX() public {
        _approveRouterFor(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(bytes("ESwap: MUST_PAIR_WITH_ETX"));
        router.addLiquidity(
            address(eti),
            address(usdt),
            10_000 ether,
            10_000 ether,
            0,
            0,
            ALICE,
            block.timestamp + 1
        );
    }

    function test_router_swapExactTokensForTokens_respectsFee() public {
        _approveRouterFor(ALICE);
        _approveRouterFor(BOB);

        vm.prank(ALICE);
        router.addLiquidity(
            address(eti),
            address(etx),
            100_000 ether,
            100_000 ether,
            0,
            0,
            ALICE,
            block.timestamp + 1
        );

        uint256 bobEtxBefore = etx.balanceOf(BOB);
        uint256 amountIn = 1_000 ether;

        address[] memory path = new address[](2);
        path[0] = address(eti);
        path[1] = address(etx);

        uint256[] memory expected = router.getAmountsOut(amountIn, path);

        vm.prank(BOB);
        uint256[] memory amounts =
            router.swapExactTokensForTokens(amountIn, 0, path, BOB, block.timestamp + 1);

        assertEq(amounts[1], expected[1]);
        assertEq(etx.balanceOf(BOB) - bobEtxBefore, expected[1]);
        // 0.30% fee on 1000 in 1:1 pool ≈ gets <997 units out (not 1000)
        assertLt(expected[1], 1_000 ether);
        assertGt(expected[1], 900 ether);
    }

    function test_router_multihop_ETI_to_USDT_viaETX() public {
        // Hub-and-spoke in action: with only ETI/ETX and USDT/ETX pools, a user
        // trading ETI → USDT is forced through ETX (2-hop). This is the
        // protocol-level guarantee the factory require() gives us.
        _approveRouterFor(ALICE);
        _approveRouterFor(BOB);

        vm.startPrank(ALICE);
        router.addLiquidity(
            address(eti),
            address(etx),
            100_000 ether,
            100_000 ether,
            0,
            0,
            ALICE,
            block.timestamp + 1
        );
        router.addLiquidity(
            address(usdt),
            address(etx),
            100_000 ether,
            100_000 ether,
            0,
            0,
            ALICE,
            block.timestamp + 1
        );
        vm.stopPrank();

        address[] memory path = new address[](3);
        path[0] = address(eti);
        path[1] = address(etx);
        path[2] = address(usdt);

        uint256 bobUsdtBefore = usdt.balanceOf(BOB);
        uint256[] memory expected = router.getAmountsOut(1_000 ether, path);

        vm.prank(BOB);
        uint256[] memory amounts =
            router.swapExactTokensForTokens(1_000 ether, 0, path, BOB, block.timestamp + 1);

        assertEq(amounts[2], expected[2]);
        assertEq(usdt.balanceOf(BOB) - bobUsdtBefore, expected[2]);
        // Two 0.30% fees compounded → user receives noticeably less than 1000.
        assertLt(expected[2], 1_000 ether);
        assertGt(expected[2], 900 ether);
    }

    function test_router_removeLiquidity_burnsAndReturns() public {
        _approveRouterFor(ALICE);
        vm.prank(ALICE);
        (,, uint256 liq) = router.addLiquidity(
            address(eti), address(etx), 10_000 ether, 10_000 ether, 0, 0, ALICE, block.timestamp + 1
        );

        address pair = factory.getPair(address(eti), address(etx));
        vm.prank(ALICE);
        IEticaSwapPair(pair).approve(address(router), liq);

        uint256 etiBefore = eti.balanceOf(ALICE);
        uint256 etxBefore = etx.balanceOf(ALICE);

        vm.prank(ALICE);
        (uint256 aOut, uint256 bOut) = router.removeLiquidity(
            address(eti), address(etx), liq, 0, 0, ALICE, block.timestamp + 1
        );

        assertGt(aOut, 0);
        assertGt(bOut, 0);
        assertEq(eti.balanceOf(ALICE) - etiBefore, aOut);
        assertEq(etx.balanceOf(ALICE) - etxBefore, bOut);
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
        // WEGAZ/ETX is the EGAZ-onramp pool under the hub-and-spoke model:
        // users wrap native EGAZ → WEGAZ → swap to ETX → swap to anything.
        _approveRouterFor(ALICE);

        vm.prank(ALICE);
        router.addLiquidityEGAZ{value: 100 ether}(
            address(etx), 100_000 ether, 0, 0, ALICE, block.timestamp + 1
        );

        address[] memory path = new address[](2);
        path[0] = address(wegaz);
        path[1] = address(etx);

        uint256 bobEtxBefore = etx.balanceOf(BOB);

        vm.prank(BOB);
        router.swapExactEGAZForTokens{value: 1 ether}(0, path, BOB, block.timestamp + 1);

        assertGt(etx.balanceOf(BOB) - bobEtxBefore, 0);
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
            address(etx),
            100_000 ether,
            100_000 ether,
            0,
            0,
            ALICE,
            block.timestamp + 1
        );

        address pair = factory.getPair(address(eti), address(etx));

        // Do a bunch of swaps back and forth to grow k.
        for (uint256 i; i < 5; i++) {
            address[] memory p0 = new address[](2);
            p0[0] = address(eti);
            p0[1] = address(etx);
            vm.prank(BOB);
            router.swapExactTokensForTokens(500 ether, 0, p0, BOB, block.timestamp + 1);

            address[] memory p1 = new address[](2);
            p1[0] = address(etx);
            p1[1] = address(eti);
            vm.prank(BOB);
            router.swapExactTokensForTokens(500 ether, 0, p1, BOB, block.timestamp + 1);
        }

        // Trigger fee mint via another add/remove liquidity.
        vm.prank(ALICE);
        router.addLiquidity(
            address(eti), address(etx), 1 ether, 1 ether, 0, 0, ALICE, block.timestamp + 1
        );

        assertGt(IEticaSwapPair(pair).balanceOf(address(0xCAFE)), 0);
    }
}
