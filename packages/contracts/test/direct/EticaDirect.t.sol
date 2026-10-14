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

    function test_swap_feeIsOnePercent() public {
        _seedDirectPool();
        uint256 amountIn = 100 ether;
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rIn, uint256 rOut) = pair.token0() == address(usdce) ? (r0, r1) : (r1, r0);
        uint256 expected = (amountIn * 990 * rOut) / (rIn * 1000 + amountIn * 990);
        assertEq(router.getAmountOut(amountIn, rIn, rOut), expected);

        // The 0.30% venue's output is too much for a 1.00% pair: K check rejects it.
        uint256 tooMuch = (amountIn * 997 * rOut) / (rIn * 1000 + amountIn * 997);
        usdce.mint(address(pair), amountIn);
        (uint256 out0, uint256 out1) =
            pair.token0() == address(usdce) ? (uint256(0), tooMuch) : (tooMuch, uint256(0));
        vm.prank(STAKER);
        vm.expectRevert(bytes("ESwap: K"));
        pair.swap(out0, out1, STAKER, "");
        (out0, out1) =
            pair.token0() == address(usdce) ? (uint256(0), expected) : (expected, uint256(0));
        vm.prank(STAKER);
        pair.swap(out0, out1, STAKER, "");
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
        (uint256 total, uint256 polLp) = adapter.harvest(plans);
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
        adapter.harvest(plans);

        plans[0].pair = address(0xBAD);
        vm.prank(TREASURY);
        vm.expectRevert(
            abi.encodeWithSelector(DirectSwapHarvesterAdapter.NotVenuePair.selector, address(0xBAD))
        );
        adapter.harvest(plans);
    }
}
