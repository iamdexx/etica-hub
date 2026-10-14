// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EticaSwapFactory} from "../../src/swap/EticaSwapFactory.sol";
import {EticaSwapRouter} from "../../src/swap/EticaSwapRouter.sol";
import {EticaDirectRouter} from "../../src/direct/EticaDirectRouter.sol";
import {WEGAZ} from "../../src/swap/WEGAZ.sol";
import {IEticaSwapPair} from "../../src/swap/interfaces/IEticaSwapPair.sol";
import {StakedETX} from "../../src/etx/StakedETX.sol";
import {EticaDirectFactory} from "../../src/direct/EticaDirectFactory.sol";
import {IEticaDirectFactory} from "../../src/direct/IEticaDirectFactory.sol";
import {IEticaDirectPair} from "../../src/direct/IEticaDirectPair.sol";
import {
    DirectSwapHarvesterAdapter,
    IHubRouter
} from "../../src/direct/DirectSwapHarvesterAdapter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract MockRewardSink {
    IERC20 public immutable etx;
    uint256 public received;

    constructor(IERC20 _etx) {
        etx = _etx;
    }

    function distributeRewards(uint256 amount) external {
        etx.transferFrom(msg.sender, address(this), amount);
        received += amount;
    }
}

contract EticaDirectTest is Test {
    address internal constant TREASURY = address(0x7EA5);
    address internal constant STAKER = address(0x57A4E);
    address internal constant NOBODY = address(0x0B0D);
    uint256 internal constant MIN_STETX = 1_000 ether;

    MockERC20 internal etx;
    MockERC20 internal usdce;
    WEGAZ internal wegaz;
    StakedETX internal stEtx;

    EticaSwapFactory internal hubFactory;
    EticaSwapRouter internal hubRouter;
    EticaDirectFactory internal factory;
    EticaDirectRouter internal router;
    DirectSwapHarvesterAdapter internal adapter;
    IEticaSwapPair internal pair; // WEGAZ/USDC.e direct pair
    MockRewardSink internal farms;

    function setUp() public {
        etx = new MockERC20("ETX (mock)", "ETX");
        usdce = new MockERC20("USDC.e (mock)", "USDC.e");
        wegaz = new WEGAZ();
        stEtx = new StakedETX(IERC20(address(etx)));
        farms = new MockRewardSink(IERC20(address(etx)));

        hubFactory = new EticaSwapFactory(TREASURY, address(etx));
        hubRouter = new EticaSwapRouter(address(hubFactory), address(wegaz));

        factory = new EticaDirectFactory(TREASURY, address(stEtx), MIN_STETX);
        router = new EticaDirectRouter(address(factory), address(wegaz));
        adapter = new DirectSwapHarvesterAdapter(
            TREASURY,
            IEticaDirectFactory(address(factory)),
            IHubRouter(address(hubRouter)),
            IERC20(address(etx)),
            address(stEtx),
            address(farms),
            TREASURY
        );
        vm.startPrank(TREASURY);
        factory.setWhitelist(address(router), true);
        factory.setWhitelist(address(adapter), true);
        factory.setFeeTo(address(adapter));
        pair = IEticaSwapPair(factory.createPair(address(wegaz), address(usdce)));
        _setTiers();
        vm.stopPrank();

        // Hub pools so the adapter can swap WEGAZ and USDC.e legs into ETX.
        etx.mint(TREASURY, 10_000_000 ether);
        usdce.mint(TREASURY, 1_000_000 ether);
        vm.deal(TREASURY, 100_000 ether);
        vm.startPrank(TREASURY);
        etx.approve(address(hubRouter), type(uint256).max);
        usdce.approve(address(hubRouter), type(uint256).max);
        hubRouter.addLiquidity(
            address(etx),
            address(usdce),
            1_000_000 ether,
            100_000 ether,
            0,
            0,
            TREASURY,
            block.timestamp
        );
        hubRouter.addLiquidityEGAZ{value: 50_000 ether}(
            address(etx), 1_000_000 ether, 0, 0, TREASURY, block.timestamp
        );
        vm.stopPrank();

        // STAKER holds stETX, NOBODY holds nothing.
        etx.mint(STAKER, 100_000 ether);
        usdce.mint(STAKER, 100_000 ether);
        usdce.mint(NOBODY, 100_000 ether);
        vm.deal(STAKER, 100_000 ether);
        vm.deal(NOBODY, 100_000 ether);
        vm.startPrank(STAKER);
        etx.approve(address(stEtx), type(uint256).max);
        stEtx.deposit(MIN_STETX, STAKER);
        usdce.approve(address(router), type(uint256).max);
        vm.stopPrank();
        vm.prank(NOBODY);
        usdce.approve(address(router), type(uint256).max);
    }

    // Mirrors the launch ladder (40k / 100k / 250k / 500k stETX) scaled to MIN_STETX.
    function _setTiers() internal {
        uint256[] memory mins = new uint256[](4);
        uint16[] memory bps = new uint16[](4);
        mins[0] = MIN_STETX;
        bps[0] = 300;
        mins[1] = MIN_STETX * 5 / 2;
        bps[1] = 150;
        mins[2] = MIN_STETX * 25 / 4;
        bps[2] = 50;
        mins[3] = MIN_STETX * 25 / 2;
        bps[3] = 10;
        factory.setFeeTiers(mins, bps);
    }

    function _quoteOut(uint256 amountIn, uint256 rIn, uint256 rOut, uint256 feeBps)
        internal
        pure
        returns (uint256)
    {
        return (amountIn * (10_000 - feeBps) * rOut) / (rIn * 10_000 + amountIn * (10_000 - feeBps));
    }

    function _seedDirectPool() internal {
        vm.prank(STAKER);
        router.addLiquidityEGAZ{value: 10_000 ether}(
            address(usdce), 10_000 ether, 0, 0, STAKER, block.timestamp
        );
    }

    // ---------- factory / gate ----------

    function test_createPair_onlyCuratedAndNoEtxRule() public {
        vm.prank(NOBODY);
        vm.expectRevert(bytes("EDirect: NOT_CREATOR"));
        factory.createPair(address(etx), address(usdce));
        assertEq(factory.allPairsLength(), 1);
        assertTrue(factory.isPair(address(pair)));
        assertEq(pair.token0() == address(wegaz) || pair.token1() == address(wegaz), true);
    }

    function test_isAllowed_gate() public view {
        assertTrue(factory.isAllowed(STAKER));
        assertFalse(factory.isAllowed(NOBODY));
        assertTrue(factory.isAllowed(address(router)));
        assertFalse(factory.isAllowed(address(pair))); // pairs are recipients only via a whitelisted router
    }

    function test_setMinStEtx_zeroOpensVenue() public {
        vm.prank(TREASURY);
        factory.setMinStEtx(0);
        assertTrue(factory.isAllowed(NOBODY));
    }

    // ---------- liquidity ----------

    function test_addLiquidity_stakerOk_nonStakerReverts() public {
        _seedDirectPool();
        assertGt(pair.balanceOf(STAKER), 0);

        vm.prank(NOBODY);
        vm.expectRevert(bytes("EDirect: NOT_STAKER"));
        router.addLiquidityEGAZ{value: 1 ether}(
            address(usdce), 1 ether, 0, 0, NOBODY, block.timestamp
        );
    }

    function test_removeLiquidity_requiresStaker() public {
        _seedDirectPool();
        uint256 lp = pair.balanceOf(STAKER);
        vm.startPrank(STAKER);
        pair.approve(address(router), lp);
        // Staker sells their stETX -> no longer allowed to pull LP out.
        stEtx.transfer(NOBODY, MIN_STETX);
        vm.expectRevert(bytes("EDirect: NOT_STAKER"));
        router.removeLiquidityEGAZ(address(usdce), lp, 0, 0, STAKER, block.timestamp);
        vm.stopPrank();
        // Now NOBODY holds the stETX: they are the staker and may receive output.
        vm.prank(STAKER);
        router.removeLiquidityEGAZ(address(usdce), lp, 0, 0, NOBODY, block.timestamp);
    }

    // ---------- swaps ----------

    function test_swap_stakerOk_nonStakerReverts() public {
        _seedDirectPool();
        address[] memory path = new address[](2);
        path[0] = address(usdce);
        path[1] = address(wegaz);

        uint256 before = STAKER.balance;
        vm.prank(STAKER);
        router.swapExactTokensForEGAZ(100 ether, 0, path, STAKER, block.timestamp);
        assertGt(STAKER.balance, before);

        vm.prank(NOBODY);
        vm.expectRevert(bytes("EDirect: NOT_STAKER"));
        router.swapExactTokensForEGAZ(100 ether, 0, path, NOBODY, block.timestamp);
    }

    function test_swap_directOnPair_requiresStakerRecipient() public {
        _seedDirectPool();
        usdce.mint(address(pair), 100 ether);
        vm.prank(NOBODY);
        vm.expectRevert(bytes("EDirect: NOT_STAKER"));
        pair.swap(0, 1 ether, NOBODY, "");
    }

    function test_swap_emitsV2EventsForIndexers() public {
        _seedDirectPool();
        address[] memory path = new address[](2);
        path[0] = address(usdce);
        path[1] = address(wegaz);
        vm.recordLogs();
        vm.prank(STAKER);
        router.swapExactTokensForEGAZ(100 ether, 0, path, STAKER, block.timestamp);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 syncSig = keccak256("Sync(uint112,uint112)");
        bytes32 swapSig = keccak256("Swap(address,uint256,uint256,uint256,uint256,address)");
        bool sawSync;
        bool sawSwap;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(pair)) continue;
            if (logs[i].topics[0] == syncSig) sawSync = true;
            if (logs[i].topics[0] == swapSig) sawSwap = true;
        }
        assertTrue(sawSync && sawSwap);
    }

    function test_fee_tiersFollowStEtxBalance() public {
        // Below first tier -> base 3%; whitelisted contracts and non-stakers too.
        assertEq(factory.feeBpsFor(NOBODY), 300);
        assertEq(factory.feeBpsFor(address(router)), 300);
        assertEq(factory.feeBpsFor(STAKER), 300); // holds exactly MIN_STETX
        vm.startPrank(STAKER);
        stEtx.deposit(MIN_STETX * 3 / 2, STAKER); // 2.5x
        assertEq(factory.feeBpsFor(STAKER), 150);
        stEtx.deposit(MIN_STETX * 15 / 4, STAKER); // 6.25x
        assertEq(factory.feeBpsFor(STAKER), 50);
        stEtx.deposit(MIN_STETX * 25 / 4, STAKER); // 12.5x
        assertEq(factory.feeBpsFor(STAKER), 10);
        stEtx.deposit(MIN_STETX * 10, STAKER); // beyond the ladder stays at the floor
        assertEq(factory.feeBpsFor(STAKER), 10);
        vm.stopPrank();
    }

    function test_fee_setTiersValidation() public {
        uint256[] memory mins = new uint256[](2);
        uint16[] memory bps = new uint16[](2);
        mins[0] = 2 ether;
        mins[1] = 1 ether;
        bps[0] = 100;
        bps[1] = 50;
        vm.startPrank(TREASURY);
        vm.expectRevert(bytes("EDirect: TIERS_NOT_ASCENDING"));
        factory.setFeeTiers(mins, bps);
        mins[1] = 3 ether;
        bps[1] = 200;
        vm.expectRevert(bytes("EDirect: FEE_NOT_DESCENDING"));
        factory.setFeeTiers(mins, bps);
        bps[0] = 400; // above base fee
        vm.expectRevert(bytes("EDirect: FEE_NOT_DESCENDING"));
        factory.setFeeTiers(mins, bps);
        vm.expectRevert(bytes("EDirect: FEE_TOO_HIGH"));
        factory.setBaseFeeBps(1_001);
        // Base fee can never undercut the first tier (300 bps in setUp).
        vm.expectRevert(bytes("EDirect: FEE_BELOW_TIERS"));
        factory.setBaseFeeBps(299);
        factory.setBaseFeeBps(500);
        assertEq(factory.feeBpsFor(NOBODY), 500);
        vm.stopPrank();
        vm.prank(NOBODY);
        vm.expectRevert(bytes("EDirect: FORBIDDEN"));
        factory.setBaseFeeBps(100);
    }

    function test_swap_pairChargesTraderTier() public {
        _seedDirectPool();
        uint256 amountIn = 100 ether;
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rIn, uint256 rOut) = pair.token0() == address(usdce) ? (r0, r1) : (r1, r0);
        uint256 at3pct = _quoteOut(amountIn, rIn, rOut, 300);
        uint256 at1pct = _quoteOut(amountIn, rIn, rOut, 100);
        assertEq(router.getAmountOut(amountIn, rIn, rOut, 300), at3pct);

        // STAKER sits on the 3% tier: a 1% output breaks K, the 3% output passes.
        usdce.mint(address(pair), amountIn);
        (uint256 out0, uint256 out1) =
            pair.token0() == address(usdce) ? (uint256(0), at1pct) : (at1pct, uint256(0));
        vm.prank(STAKER);
        vm.expectRevert(bytes("ESwap: K"));
        pair.swap(out0, out1, STAKER, "");
        (out0, out1) = pair.token0() == address(usdce) ? (uint256(0), at3pct) : (at3pct, uint256(0));
        vm.prank(STAKER);
        pair.swap(out0, out1, STAKER, "");
    }

    function test_swap_routerPricesEgazUnwrapAtTraderTier() public {
        _seedDirectPool();
        // Move STAKER to the 0.10% tier.
        vm.prank(STAKER);
        stEtx.deposit(MIN_STETX * 12, STAKER);
        assertEq(factory.feeBpsFor(STAKER), 10);
        uint256 amountIn = 100 ether;
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rIn, uint256 rOut) = pair.token0() == address(usdce) ? (r0, r1) : (r1, r0);
        uint256 expected = _quoteOut(amountIn, rIn, rOut, 10);
        address[] memory path = new address[](2);
        path[0] = address(usdce);
        path[1] = address(wegaz);
        assertEq(router.getAmountsOut(amountIn, path, STAKER)[1], expected);
        // Recipient is the router (unwrap hop) but the fee is the trader's 0.10%.
        uint256 before = STAKER.balance;
        vm.prank(STAKER);
        router.swapExactTokensForEGAZ(amountIn, expected, path, STAKER, block.timestamp);
        assertEq(STAKER.balance - before, expected);
    }

    function test_swap_routerBillsSignerNotRecipient() public {
        _seedDirectPool();
        address whale = makeAddr("whale");
        etx.mint(whale, 100_000 ether);
        vm.startPrank(whale);
        etx.approve(address(stEtx), type(uint256).max);
        stEtx.deposit(MIN_STETX * 13, whale);
        vm.stopPrank();
        assertEq(factory.feeBpsFor(whale), 10);
        assertEq(factory.feeBpsFor(STAKER), 300);
        address[] memory path = new address[](2);
        path[0] = address(usdce);
        path[1] = address(wegaz);
        // STAKER (3%) sending output to the whale (0.1%) is still charged 3%:
        // the whale's quote is too optimistic for STAKER's tier.
        uint256 whaleQuote = router.getAmountsOut(100 ether, path, whale)[1];
        uint256 stakerQuote = router.getAmountsOut(100 ether, path, STAKER)[1];
        assertLt(stakerQuote, whaleQuote);
        vm.prank(STAKER);
        vm.expectRevert(bytes("ESwap: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactTokensForTokens(100 ether, whaleQuote, path, whale, block.timestamp);
        vm.prank(STAKER);
        uint256[] memory amounts =
            router.swapExactTokensForTokens(100 ether, stakerQuote, path, whale, block.timestamp);
        assertEq(amounts[1], stakerQuote);
        // A non-staker cannot sign a swap even when the recipient is a staker.
        vm.prank(NOBODY);
        vm.expectRevert(bytes("EDirect: NOT_STAKER"));
        router.swapExactTokensForTokens(100 ether, 0, path, STAKER, block.timestamp);
    }

    function test_swapFor_onlyWhitelistedCallerAndStakerTrader() public {
        _seedDirectPool();
        usdce.mint(address(pair), 100 ether);
        (uint256 out0, uint256 out1) = pair.token0() == address(usdce)
            ? (uint256(0), uint256(1 ether))
            : (uint256(1 ether), uint256(0));
        vm.prank(STAKER);
        vm.expectRevert(bytes("EDirect: NOT_ROUTER"));
        IEticaDirectPair(address(pair)).swapFor(out0, out1, STAKER, STAKER, "");
        // A whitelisted caller cannot name a non-staker as trader either.
        vm.prank(address(adapter));
        vm.expectRevert(bytes("EDirect: NOT_STAKER"));
        IEticaDirectPair(address(pair)).swapFor(out0, out1, STAKER, NOBODY, "");
    }

    function test_addLiquidity_unopenedPairReverts() public {
        MockERC20 other = new MockERC20("Other", "OTH");
        other.mint(STAKER, 1 ether);
        vm.startPrank(STAKER);
        other.approve(address(router), type(uint256).max);
        vm.expectRevert(bytes("EDirect: NO_PAIR"));
        router.addLiquidityEGAZ{value: 1 ether}(
            address(other), 1 ether, 0, 0, STAKER, block.timestamp
        );
        vm.stopPrank();
    }

    function test_swap_nonStakerCannotParkOutputOnSiblingPair() public {
        _seedDirectPool();
        vm.prank(TREASURY);
        address sibling = factory.createPair(address(etx), address(usdce));
        usdce.mint(address(pair), 100 ether);
        (uint256 out0, uint256 out1) = pair.token0() == address(usdce)
            ? (uint256(0), uint256(1 ether))
            : (uint256(1 ether), uint256(0));
        vm.prank(NOBODY);
        vm.expectRevert(bytes("EDirect: NOT_STAKER"));
        pair.swap(out0, out1, sibling, "");
        // skim is gated the same way.
        vm.prank(NOBODY);
        vm.expectRevert(bytes("EDirect: NOT_STAKER"));
        pair.skim(NOBODY);
        vm.prank(NOBODY);
        pair.skim(STAKER);
    }

    function test_gate_venueContractsAreNotRecipientsForOutsiders() public {
        _seedDirectPool();
        usdce.mint(address(pair), 100 ether);
        (uint256 out0, uint256 out1) = pair.token0() == address(usdce)
            ? (uint256(0), uint256(1 ether))
            : (uint256(1 ether), uint256(0));
        // Non-staker cannot dump output into the whitelisted router.
        vm.prank(NOBODY);
        vm.expectRevert(bytes("EDirect: NOT_STAKER"));
        pair.swap(out0, out1, address(router), "");
        vm.prank(NOBODY);
        vm.expectRevert(bytes("EDirect: NOT_STAKER"));
        pair.swap(out0, out1, address(adapter), "");
        // Even a staker cannot route to the router or a pair through the router.
        address[] memory path = new address[](2);
        path[0] = address(usdce);
        path[1] = address(wegaz);
        vm.startPrank(STAKER);
        vm.expectRevert(bytes("EDirect: INVALID_TO"));
        router.swapExactTokensForTokens(1 ether, 0, path, address(router), block.timestamp);
        vm.expectRevert(bytes("EDirect: INVALID_TO"));
        router.swapExactTokensForTokens(1 ether, 0, path, address(pair), block.timestamp);
        vm.stopPrank();
    }

    // ---------- fee harvest -> stETX ----------

    function test_harvest_feesFlowToStakersAndTreasury() public {
        _seedDirectPool();
        address[] memory path = new address[](2);
        path[0] = address(usdce);
        path[1] = address(wegaz);
        vm.startPrank(STAKER);
        for (uint256 i; i < 20; i++) {
            router.swapExactTokensForEGAZ(500 ether, 0, path, STAKER, block.timestamp);
        }
        // A liquidity event crystallises the protocol fee as LP minted to the adapter.
        router.addLiquidityEGAZ{value: 1 ether}(
            address(usdce), 100 ether, 0, 0, STAKER, block.timestamp
        );
        vm.stopPrank();
        assertGt(pair.balanceOf(address(adapter)), 0);

        uint256 navBefore = stEtx.convertToAssets(1e18);
        uint256 treasuryBefore = etx.balanceOf(TREASURY);
        DirectSwapHarvesterAdapter.LegPlan[] memory plans =
            new DirectSwapHarvesterAdapter.LegPlan[](1);
        plans[0] = DirectSwapHarvesterAdapter.LegPlan(address(pair), 0, 0, 0, 0);
        uint256 deadBefore = pair.balanceOf(adapter.DEAD());
        vm.prank(TREASURY);
        (uint256 total, uint256 polLp) = adapter.harvest(plans, 0);
        assertGt(total, 0);
        // 10% stETX, 10% farms, 40% POL burned into the direct pair, 40% treasury.
        assertGt(stEtx.convertToAssets(1e18), navBefore);
        assertEq(farms.received(), total / 10);
        assertGt(polLp, 0);
        assertEq(pair.balanceOf(adapter.DEAD()) - deadBefore, polLp);
        assertEq(
            etx.balanceOf(TREASURY) - treasuryBefore,
            total - total / 10 - total / 10 - (total * 4) / 10
        );
        assertEq(pair.balanceOf(address(adapter)), 0);
        assertEq(etx.balanceOf(address(adapter)), 0);
    }

    function test_harvest_onlyKeeper_andOnlyVenuePairs() public {
        DirectSwapHarvesterAdapter.LegPlan[] memory plans =
            new DirectSwapHarvesterAdapter.LegPlan[](1);
        plans[0] = DirectSwapHarvesterAdapter.LegPlan(address(pair), 0, 0, 0, 0);
        vm.prank(NOBODY);
        vm.expectRevert(DirectSwapHarvesterAdapter.NotKeeper.selector);
        adapter.harvest(plans, 0);

        plans[0].pair = address(0xBAD);
        vm.prank(TREASURY);
        vm.expectRevert(
            abi.encodeWithSelector(DirectSwapHarvesterAdapter.NotVenuePair.selector, address(0xBAD))
        );
        adapter.harvest(plans, 0);
    }
}
