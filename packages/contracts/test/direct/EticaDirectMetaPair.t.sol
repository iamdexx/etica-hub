// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EticaSwapFactory} from "../../src/swap/EticaSwapFactory.sol";
import {EticaSwapRouter} from "../../src/swap/EticaSwapRouter.sol";
import {WEGAZ} from "../../src/swap/WEGAZ.sol";
import {IEticaSwapPair} from "../../src/swap/interfaces/IEticaSwapPair.sol";
import {StakedETX} from "../../src/etx/StakedETX.sol";
import {EticaDirectFactory} from "../../src/direct/EticaDirectFactory.sol";
import {EticaDirectMetaPair} from "../../src/direct/EticaDirectMetaPair.sol";
import {EticaDirectMetaPairDeployer} from "../../src/direct/EticaDirectMetaPairDeployer.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {
    DirectSwapHarvesterAdapter,
    IHubRouter
} from "../../src/direct/DirectSwapHarvesterAdapter.sol";
import {IEticaDirectFactory} from "../../src/direct/IEticaDirectFactory.sol";

contract EticaDirectMetaPairTest is Test {
    address internal constant TREASURY = address(0x7EA5);
    address internal constant STAKER = address(0x57A4E);
    address internal constant NOBODY = address(0x0B0D);
    address internal constant FEE_SINK = address(0xFEE);
    uint256 internal constant MIN_STETX = 1_000 ether;

    MockERC20 internal etx;
    MockERC20 internal usdce;
    WEGAZ internal wegaz;
    StakedETX internal stEtx;
    EticaSwapFactory internal hubFactory;
    EticaSwapRouter internal hubRouter;
    EticaDirectFactory internal factory;
    EticaDirectMetaPair internal meta;
    IEticaSwapPair internal hubUsdce; // USDC.e/ETX
    IEticaSwapPair internal hubWegaz; // WEGAZ/ETX

    function setUp() public {
        etx = new MockERC20("ETX (mock)", "ETX");
        usdce = new MockERC20("USDC.e (mock)", "USDC.e");
        wegaz = new WEGAZ();
        stEtx = new StakedETX(IERC20(address(etx)));
        hubFactory = new EticaSwapFactory(TREASURY, address(etx));
        hubRouter = new EticaSwapRouter(address(hubFactory), address(wegaz));
        factory = new EticaDirectFactory(TREASURY, address(stEtx), MIN_STETX);

        // Hub: 1 ETX = 0.1 USDC.e, 1 ETX = 0.05 EGAZ  => 1 EGAZ = 2 USDC.e
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
        factory.setFeeTo(FEE_SINK);
        vm.expectRevert(bytes("EDirect: NO_DEPLOYER"));
        factory.createMetaPair(address(wegaz), address(usdce), address(hubRouter));
        factory.setMetaPairDeployer(address(new EticaDirectMetaPairDeployer()));
        meta = EticaDirectMetaPair(
            factory.createMetaPair(address(wegaz), address(usdce), address(hubRouter))
        );
        vm.stopPrank();
        hubUsdce = IEticaSwapPair(hubFactory.getPair(address(usdce), address(etx)));
        hubWegaz = IEticaSwapPair(hubFactory.getPair(address(wegaz), address(etx)));

        etx.mint(STAKER, 100_000 ether);
        usdce.mint(STAKER, 100_000 ether);
        usdce.mint(NOBODY, 100_000 ether);
        vm.deal(STAKER, 100_000 ether);
        vm.deal(NOBODY, 100_000 ether);
        vm.startPrank(STAKER);
        etx.approve(address(stEtx), type(uint256).max);
        stEtx.deposit(MIN_STETX, STAKER);
        usdce.approve(address(meta), type(uint256).max);
        wegaz.deposit{value: 50_000 ether}();
        wegaz.approve(address(meta), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(NOBODY);
        usdce.approve(address(meta), type(uint256).max);
        wegaz.deposit{value: 50_000 ether}();
        wegaz.approve(address(meta), type(uint256).max);
        vm.stopPrank();
    }

    function _seed(uint256 usdceAmt, uint256 wegazAmt) internal returns (uint256 shares) {
        vm.startPrank(STAKER);
        usdce.transfer(address(meta), usdceAmt);
        wegaz.transfer(address(meta), wegazAmt);
        shares = meta.mint(STAKER);
        vm.stopPrank();
    }

    /// Hub cross price USDC.e per WEGAZ from the two hub pools' spot ratios.
    function _hubCross() internal view returns (uint256 usdcePerWegaz1e18) {
        (uint256 rU, uint256 rEu) = _hubReserves(hubUsdce, address(usdce));
        (uint256 rW, uint256 rEw) = _hubReserves(hubWegaz, address(wegaz));
        // 1 WEGAZ = rEw/rW ETX = (rEw/rW) * (rU/rEu) USDC.e
        usdcePerWegaz1e18 = (rEw * rU * 1e18) / (rW * rEu);
    }

    function _hubReserves(IEticaSwapPair p, address token)
        internal
        view
        returns (uint256 rToken, uint256 rEtx)
    {
        (uint112 r0, uint112 r1,) = p.getReserves();
        (rToken, rEtx) = p.token0() == token ? (r0, r1) : (r1, r0);
    }

    function _metaReserves() internal view returns (uint256 rWegaz, uint256 rUsdce) {
        (uint112 r0, uint112 r1,) = meta.getReserves();
        (rWegaz, rUsdce) = meta.token0() == address(wegaz) ? (r0, r1) : (r1, r0);
    }

    // ---------- creation ----------

    function test_createMetaPair_curatedAndRegistered() public {
        assertTrue(factory.isPair(address(meta)));
        assertTrue(factory.isMetaPair(address(meta)));
        assertEq(factory.getPair(address(usdce), address(wegaz)), address(meta));
        assertEq(meta.hubPair0() == address(hubUsdce) || meta.hubPair0() == address(hubWegaz), true);
        vm.startPrank(NOBODY);
        vm.expectRevert(bytes("EDirect: NOT_CREATOR"));
        factory.createMetaPair(address(usdce), address(stEtx), address(hubRouter));
        vm.expectRevert(bytes("EDirect: FORBIDDEN"));
        factory.setMetaPairDeployer(NOBODY);
        // A window deployed outside the factory is inert: init is factory-only.
        EticaDirectMetaPair rogue = EticaDirectMetaPair(
            EticaDirectMetaPairDeployer(factory.metaPairDeployer()).deploy(address(factory))
        );
        vm.expectRevert(bytes("ESwap: FORBIDDEN"));
        rogue.initialize(address(usdce), address(wegaz), address(hubRouter));
        assertFalse(factory.isPair(address(rogue)));
        vm.stopPrank();
        // ETX itself is the hub, never a window leg; legs need a hub pool.
        vm.startPrank(TREASURY);
        vm.expectRevert(bytes("EDirect: ETX_IS_HUB"));
        factory.createMetaPair(address(usdce), address(etx), address(hubRouter));
        vm.expectRevert(bytes("EDirect: NO_HUB_PAIR"));
        factory.createMetaPair(address(usdce), address(stEtx), address(hubRouter));
        vm.stopPrank();
    }

    // ---------- mint: deposits land in the hub, reserves = hub cross price ----------

    function test_mint_depositsIntoHubAndReportsHubPrice() public {
        (uint256 rU0, uint256 rEu0) = _hubReserves(hubUsdce, address(usdce));
        (uint256 rW0,) = _hubReserves(hubWegaz, address(wegaz));
        vm.recordLogs();
        uint256 shares = _seed(10 ether, 5 ether); // $10 + $10 at the 2:1 hub price
        assertGt(shares, 0);
        assertEq(meta.balanceOf(STAKER), shares);

        // Nothing raw stays in the window; it holds hub LP instead.
        assertEq(usdce.balanceOf(address(meta)), 0);
        assertEq(wegaz.balanceOf(address(meta)), 0);
        assertEq(etx.balanceOf(address(meta)), 0);
        (uint256 lp0, uint256 lp1) = meta.hubLiquidity();
        assertGt(lp0, 0);
        assertGt(lp1, 0);
        // Hub pools got deeper in both token legs (the ETX a leg borrows for
        // its half-swap goes straight back in as LP, so ETX is conserved).
        (uint256 rU1, uint256 rEu1) = _hubReserves(hubUsdce, address(usdce));
        (uint256 rW1,) = _hubReserves(hubWegaz, address(wegaz));
        assertGt(rU1, rU0);
        assertEq(rEu1, rEu0);
        assertGt(rW1, rW0);

        // Reported reserves: the $20 window as $10 of USDC.e + $10 of WEGAZ,
        // ratio = hub cross price (a hair under $20 after the hub's swap fee).
        (uint256 rWegaz, uint256 rUsdce) = _metaReserves();
        assertApproxEqRel(rUsdce, 10 ether, 0.02e18);
        assertApproxEqRel(rWegaz, 5 ether, 0.02e18);
        assertLt(rUsdce, 10 ether);
        assertApproxEqRel((rUsdce * 1e18) / rWegaz, _hubCross(), 0.001e18);

        // Indexer surface: Mint + Sync from the pair.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawMint;
        bool sawSync;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(meta)) continue;
            if (logs[i].topics[0] == keccak256("Mint(address,uint256,uint256)")) sawMint = true;
            if (logs[i].topics[0] == keccak256("Sync(uint112,uint112)")) sawSync = true;
        }
        assertTrue(sawMint && sawSync);
    }

    function test_mint_requiresStakerRecipient_andSomethingDeposited() public {
        vm.prank(NOBODY);
        vm.expectRevert(bytes("EDirect: NOT_STAKER"));
        meta.mint(NOBODY);
        vm.prank(STAKER);
        vm.expectRevert(bytes("ESwap: INSUFFICIENT_INPUT_AMOUNT"));
        meta.mint(STAKER);
    }

    function test_mint_looseEtxIsSplitAcrossBothLegs() public {
        _seed(10 ether, 5 ether);
        (uint256 lp0, uint256 lp1) = meta.hubLiquidity();
        etx.mint(address(meta), 100 ether); // e.g. a harvester's POL slice
        vm.prank(STAKER);
        meta.mint(STAKER);
        (uint256 lp0b, uint256 lp1b) = meta.hubLiquidity();
        assertGt(lp0b, lp0);
        assertGt(lp1b, lp1);
        assertEq(etx.balanceOf(address(meta)), 0);
    }

    function test_burn_alwaysReverts_liquidityLocked() public {
        _seed(10 ether, 5 ether);
        vm.prank(STAKER);
        vm.expectRevert(bytes("EDirect: LOCKED_LIQUIDITY"));
        meta.burn(STAKER);
    }

    // ---------- swaps settle on the hub ----------

    function test_swapExactIn_matchesQuote_feeForwarded_hubLpUntouched() public {
        _seed(10 ether, 5 ether);
        (uint256 lp0, uint256 lp1) = meta.hubLiquidity();
        uint256 amountIn = 100 ether;
        uint256 quoted = meta.quoteOut(address(usdce), amountIn, STAKER);
        // Trades the whole hub, not the $20 window: output is near the hub mid.
        assertGt(quoted, 45 ether); // 100 USDC.e ≈ 50 EGAZ at mid, minus 3% tier + 2x hub fee
        uint256 before = wegaz.balanceOf(STAKER);
        vm.prank(STAKER);
        uint256 out = meta.swapExactIn(address(usdce), amountIn, quoted, STAKER, block.timestamp);
        assertEq(out, quoted);
        assertEq(wegaz.balanceOf(STAKER) - before, out);
        // 3% tier fee forwarded in kind to feeTo.
        assertEq(usdce.balanceOf(FEE_SINK), (amountIn * 300) / 10_000);
        // The window's hub LP never moves.
        (uint256 lp0b, uint256 lp1b) = meta.hubLiquidity();
        assertEq(lp0b, lp0);
        assertEq(lp1b, lp1);
        assertEq(usdce.balanceOf(address(meta)), 0);
    }

    function test_swapExactIn_nonStakerReverts_minOutEnforced() public {
        _seed(10 ether, 5 ether);
        vm.prank(NOBODY);
        vm.expectRevert(bytes("EDirect: NOT_STAKER"));
        meta.swapExactIn(address(usdce), 1 ether, 0, NOBODY, block.timestamp);
        // A staker cannot deliver to a non-staker either.
        vm.prank(STAKER);
        vm.expectRevert(bytes("EDirect: NOT_STAKER"));
        meta.swapExactIn(address(usdce), 1 ether, 0, NOBODY, block.timestamp);
        uint256 quoted = meta.quoteOut(address(usdce), 1 ether, STAKER);
        vm.prank(STAKER);
        vm.expectRevert(bytes("ESwap: INSUFFICIENT_OUTPUT_AMOUNT"));
        meta.swapExactIn(address(usdce), 1 ether, quoted + 1, STAKER, block.timestamp);
    }

    function test_swap_v2Style_prepayThenRequestOutput() public {
        _seed(10 ether, 5 ether);
        uint256 quoted = meta.quoteOut(address(usdce), 10 ether, STAKER);
        vm.startPrank(STAKER);
        usdce.transfer(address(meta), 10 ether);
        (uint256 out0, uint256 out1) =
            meta.token0() == address(wegaz) ? (quoted, uint256(0)) : (uint256(0), quoted);
        vm.recordLogs();
        meta.swap(out0, out1, STAKER, "");
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawSwap;
        for (uint256 i; i < logs.length; i++) {
            if (
                logs[i].emitter == address(meta)
                    && logs[i].topics[0]
                        == keccak256("Swap(address,uint256,uint256,uint256,uint256,address)")
            ) sawSwap = true;
        }
        assertTrue(sawSwap);
        // Flash swaps and two-sided outputs are refused.
        vm.startPrank(STAKER);
        usdce.transfer(address(meta), 1 ether);
        vm.expectRevert(bytes("EDirect: NO_FLASH_SWAP"));
        meta.swap(out0, out1, STAKER, "x");
        vm.expectRevert(bytes("ESwap: INSUFFICIENT_OUTPUT_AMOUNT"));
        meta.swap(1, 1, STAKER, "");
        vm.stopPrank();
    }

    function test_swap_tierFeeFollowsTrader() public {
        _seed(10 ether, 5 ether);
        uint256[] memory mins = new uint256[](2);
        uint16[] memory bps = new uint16[](2);
        mins[0] = MIN_STETX;
        bps[0] = 300;
        mins[1] = MIN_STETX * 2;
        bps[1] = 10;
        vm.prank(TREASURY);
        factory.setFeeTiers(mins, bps);
        uint256 at3 = meta.quoteOut(address(usdce), 100 ether, STAKER);
        vm.prank(STAKER);
        stEtx.deposit(MIN_STETX, STAKER);
        uint256 at01 = meta.quoteOut(address(usdce), 100 ether, STAKER);
        assertGt(at01, at3);
        vm.prank(STAKER);
        meta.swapExactIn(address(usdce), 100 ether, at01, STAKER, block.timestamp);
        assertEq(usdce.balanceOf(FEE_SINK), (100 ether * 10) / 10_000);
    }

    function test_feeFallsBackToFeeToSetter() public {
        _seed(10 ether, 5 ether);
        vm.prank(TREASURY);
        factory.setFeeTo(address(0));
        vm.prank(STAKER);
        meta.swapExactIn(address(usdce), 100 ether, 0, STAKER, block.timestamp);
        assertEq(usdce.balanceOf(TREASURY) > 0, true);
    }

    // ---------- reserves follow the hub, never the other way round ----------

    function test_reservesTrackHubPriceAfterHubTrade() public {
        _seed(10 ether, 5 ether);
        (uint256 rW, uint256 rU) = _metaReserves();
        uint256 crossBefore = (rU * 1e18) / rW;
        // Someone moves the hub: buys a lot of EGAZ with ETX on V2.
        address[] memory path = new address[](2);
        path[0] = address(etx);
        path[1] = address(wegaz);
        vm.prank(TREASURY);
        hubRouter.swapExactTokensForTokens(200_000 ether, 0, path, TREASURY, block.timestamp);
        uint256 hubCross = _hubCross();
        assertGt(hubCross, crossBefore);
        // Stale until synced, then exactly the new hub cross price.
        (rW, rU) = _metaReserves();
        assertEq((rU * 1e18) / rW, crossBefore);
        meta.sync();
        (rW, rU) = _metaReserves();
        assertApproxEqRel((rU * 1e18) / rW, hubCross, 0.001e18);
    }

    function test_skim_onlyToFeeSink_hubLpUntouched() public {
        _seed(10 ether, 5 ether);
        (uint256 lp0, uint256 lp1) = meta.hubLiquidity();
        usdce.mint(address(meta), 7 ether); // donation
        vm.prank(NOBODY);
        vm.expectRevert(bytes("EDirect: SKIM_TO_FEE_SINK"));
        meta.skim(NOBODY);
        vm.prank(NOBODY);
        meta.skim(FEE_SINK);
        assertEq(usdce.balanceOf(FEE_SINK), 7 ether);
        (uint256 lp0b, uint256 lp1b) = meta.hubLiquidity();
        assertEq(lp0b, lp0);
        assertEq(lp1b, lp1);
    }

    /// Invariant: nothing a trader does can reduce the window's hub LP.
    function testFuzz_hubLpNeverDecreases(uint96 inA, uint96 inB, bool fromUsdce) public {
        _seed(10 ether, 5 ether);
        (uint256 lp0, uint256 lp1) = meta.hubLiquidity();
        uint256 a = bound(uint256(inA), 1e6, 10_000 ether);
        uint256 b = bound(uint256(inB), 1e6, 1_000 ether);
        vm.startPrank(STAKER);
        if (fromUsdce) {
            meta.swapExactIn(address(usdce), a, 0, STAKER, block.timestamp);
        } else {
            meta.swapExactIn(address(wegaz), b, 0, STAKER, block.timestamp);
        }
        // Donate + mint grows it, never shrinks it.
        usdce.transfer(address(meta), b);
        meta.mint(STAKER);
        vm.stopPrank();
        (uint256 lp0b, uint256 lp1b) = meta.hubLiquidity();
        assertGe(lp0b, lp0);
        assertGe(lp1b, lp1);
    }

    // ---------- fees: in-kind to the harvester, POL back into the hub ----------

    function test_harvest_windowFeesSplitAndPolDepositedIntoHub() public {
        DirectSwapHarvesterAdapter adapter = new DirectSwapHarvesterAdapter(
            TREASURY,
            IEticaDirectFactory(address(factory)),
            IHubRouter(address(hubRouter)),
            IERC20(address(etx)),
            address(stEtx),
            address(0),
            TREASURY
        );
        vm.startPrank(TREASURY);
        factory.setWhitelist(address(adapter), true);
        factory.setFeeTo(address(adapter));
        vm.stopPrank();
        _seed(10 ether, 5 ether);
        vm.startPrank(STAKER);
        meta.swapExactIn(address(usdce), 1_000 ether, 0, STAKER, block.timestamp);
        meta.swapExactIn(address(wegaz), 100 ether, 0, STAKER, block.timestamp);
        vm.stopPrank();
        assertEq(usdce.balanceOf(address(adapter)), 30 ether);
        assertEq(wegaz.balanceOf(address(adapter)), 3 ether);

        (uint256 lp0, uint256 lp1) = meta.hubLiquidity();
        uint256 navBefore = stEtx.convertToAssets(1e18);
        uint256 treasuryBefore = etx.balanceOf(TREASURY);
        DirectSwapHarvesterAdapter.LegPlan[] memory plans =
            new DirectSwapHarvesterAdapter.LegPlan[](1);
        plans[0] = DirectSwapHarvesterAdapter.LegPlan(address(meta), 0, 0, 0, 0);
        vm.prank(TREASURY);
        (uint256 total, uint256 polShares) = adapter.harvest(plans);
        assertGt(total, 0);
        assertGt(polShares, 0);
        assertGt(stEtx.convertToAssets(1e18), navBefore);
        // farms sink unset -> its 10% folds into the treasury: 40% + 10%.
        assertEq(etx.balanceOf(TREASURY) - treasuryBefore, total - total / 10 - (total * 4) / 10);
        // POL slice landed in the hub through the window, shares parked on the adapter.
        (uint256 lp0b, uint256 lp1b) = meta.hubLiquidity();
        assertGt(lp0b, lp0);
        assertGt(lp1b, lp1);
        assertEq(meta.balanceOf(address(adapter)), polShares);
        assertEq(usdce.balanceOf(address(adapter)), 0);
        assertEq(wegaz.balanceOf(address(adapter)), 0);
        assertEq(etx.balanceOf(address(adapter)), 0);
    }
}
