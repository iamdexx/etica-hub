// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ETXToken} from "../../src/etx/ETXToken.sol";
import {EticaResearchMarkets} from "../../src/research-markets/EticaResearchMarkets.sol";
import {ResearchToken} from "../../src/research-markets/ResearchToken.sol";

/// @notice Forge unit tests for the EticaResearchMarkets singleton.
/// @dev    Coverage targets:
///           - launch flow + toll routing into the shared pool
///           - bonding-curve buy/sell math (constant product against
///             virtual reserves)
///           - 80/10/0/10 fee router (pool / etiLpSink / treasury /
///             researcher) — the "C-with-lock" split that pulls the
///             curve floor up monotonically with use
///           - graduation flag fires at the threshold
///           - sunset flag flips after 30 days and auto-unsets on trade
///           - admin guards (owner-only)
///           - reverts on unknown markets, zero amounts, expired deadlines,
///             slippage violations
contract EticaResearchMarketsTest is Test {
    ETXToken internal etx;
    EticaResearchMarkets internal markets;

    address internal constant TREASURY_DEPLOY = address(0xD15780); // initial ETX distributor in ETXToken
    address internal constant TREASURY = address(0x7EA5);
    address internal constant ETI_LP_SINK = address(0xE71BA);
    address internal constant OWNER = address(0x9E8E5);
    address internal constant RESEARCHER = address(0xCA15E);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    uint256 internal constant ONE = 1e18;
    uint128 internal constant V_ETX_START = 5_000 * 1e18;
    uint128 internal constant V_TOKEN_START = 1_000_000_000 * 1e18;
    uint128 internal constant GRAD_THRESHOLD = 100_000 * 1e18;
    uint256 internal constant LAUNCH_TOLL = 100 * 1e18;
    uint32 internal constant SUNSET_WINDOW = 30 days;

    function setUp() public {
        // ETXToken constructor requires distributor != 0; mint to TREASURY_DEPLOY.
        etx = new ETXToken(TREASURY_DEPLOY);

        EticaResearchMarkets.ConstructorArgs memory args = EticaResearchMarkets.ConstructorArgs({
            etx: IERC20(address(etx)),
            treasury: TREASURY,
            etiLpSink: ETI_LP_SINK,
            owner: OWNER,
            launchTollEtx: LAUNCH_TOLL,
            feeRateBps: 100, // 1%
            etiLpBps: 1000, // 10%
            treasuryBps: 0, // 0%
            researcherBps: 1000, // 10%
            graduationThreshold: GRAD_THRESHOLD,
            sunsetWindow: SUNSET_WINDOW,
            defaultVirtualEtxStart: V_ETX_START,
            defaultVirtualTokenStart: V_TOKEN_START
        });
        markets = new EticaResearchMarkets(args);

        // Fund actors + seed the 5M ETX pool into the singleton.
        vm.startPrank(TREASURY_DEPLOY);
        etx.transfer(address(markets), 5_000_000 * ONE);
        etx.transfer(ALICE, 1_000_000 * ONE);
        etx.transfer(BOB, 1_000_000 * ONE);
        etx.transfer(RESEARCHER, 10_000 * ONE);
        vm.stopPrank();
    }

    function _md(string memory symbol) internal pure returns (ResearchToken.Metadata memory) {
        return ResearchToken.Metadata({
            name: string.concat("Research ", symbol),
            symbol: symbol,
            imageURI: "ipfs://image-hash",
            description: "A test research market.",
            website: "",
            telegram: "",
            xUrl: "",
            evidenceURI: "doi:10.1234/test"
        });
    }

    function _launch(address researcher, string memory symbol) internal returns (address token) {
        vm.prank(researcher);
        etx.approve(address(markets), type(uint256).max);
        vm.prank(researcher);
        token = markets.launch(_md(symbol));
    }

    // ─── Launch ───────────────────────────────────────────────────────

    function test_Launch_DeploysTokenAndChargesToll() public {
        uint256 sinkBalBefore = etx.balanceOf(address(markets));
        uint256 researcherBalBefore = etx.balanceOf(RESEARCHER);

        address token = _launch(RESEARCHER, "RX1");

        assertEq(
            etx.balanceOf(RESEARCHER), researcherBalBefore - LAUNCH_TOLL, "researcher pays toll"
        );
        assertEq(etx.balanceOf(address(markets)), sinkBalBefore + LAUNCH_TOLL, "toll lands in pool");

        EticaResearchMarkets.MarketView memory v = markets.market(token);
        assertEq(v.researcher, RESEARCHER, "researcher set");
        assertEq(v.virtualEtxStart, V_ETX_START, "vETX start set");
        assertEq(v.virtualTokenStart, V_TOKEN_START, "vToken start set");
        assertEq(v.virtualEtxAcc, 0, "vETX acc zero");
        assertEq(v.tokenSupply, 0, "supply zero");
        assertEq(v.graduatedAt, 0, "not graduated");
        assertFalse(v.sunsetted, "not sunsetted");

        // ResearchToken hooks up to singleton.
        ResearchToken rt = ResearchToken(token);
        assertEq(rt.market(), address(markets), "market wired");
        assertEq(rt.researcher(), RESEARCHER, "researcher wired");
        assertEq(rt.imageURI(), "ipfs://image-hash");
        assertEq(rt.evidenceURI(), "doi:10.1234/test");
    }

    function test_Launch_RevertsWithoutTollApproval() public {
        vm.prank(RESEARCHER);
        vm.expectRevert();
        markets.launch(_md("RX2"));
    }

    // ─── Buy ──────────────────────────────────────────────────────────

    function test_Buy_MovesPriceAlongCurve() public {
        address token = _launch(RESEARCHER, "RX1");

        uint256 etxIn = 1_000 * ONE;
        (uint256 expectedOut, uint256 expectedFee) = markets.quoteBuy(token, etxIn);
        assertGt(expectedOut, 0, "quote nonzero");
        assertEq(expectedFee, (etxIn * 100) / 10_000, "fee 1%");

        vm.prank(ALICE);
        etx.approve(address(markets), type(uint256).max);
        vm.prank(ALICE);
        uint256 got = markets.buy(token, etxIn, 0, block.timestamp + 1);

        assertEq(got, expectedOut, "buy matches quote");
        assertEq(ResearchToken(token).balanceOf(ALICE), got, "tokens minted to buyer");
    }

    function test_Buy_FeeRoutesCorrectly() public {
        address token = _launch(RESEARCHER, "RX1");

        uint256 etxIn = 1_000 * ONE;
        uint256 expectedFee = (etxIn * 100) / 10_000; // 1% = 10 ETX
        uint256 expectedEtiLp = (expectedFee * 1000) / 10_000; // 1 ETX
        uint256 expectedTreas = (expectedFee * 0) / 10_000; // 0 ETX
        uint256 expectedResch = (expectedFee * 1000) / 10_000; // 1 ETX

        uint256 etiLpBefore = etx.balanceOf(ETI_LP_SINK);
        uint256 treasBefore = etx.balanceOf(TREASURY);
        uint256 reschBefore = etx.balanceOf(RESEARCHER);

        vm.prank(ALICE);
        etx.approve(address(markets), type(uint256).max);
        vm.prank(ALICE);
        markets.buy(token, etxIn, 0, block.timestamp + 1);

        assertEq(etx.balanceOf(ETI_LP_SINK) - etiLpBefore, expectedEtiLp, "etiLp slice");
        assertEq(etx.balanceOf(TREASURY) - treasBefore, expectedTreas, "treasury slice");
        assertEq(etx.balanceOf(RESEARCHER) - reschBefore, expectedResch, "researcher slice");
    }

    function test_Buy_RevertsOnSlippage() public {
        address token = _launch(RESEARCHER, "RX1");
        vm.prank(ALICE);
        etx.approve(address(markets), type(uint256).max);
        vm.prank(ALICE);
        vm.expectRevert(); // SlippageExceeded
        markets.buy(token, 1_000 * ONE, type(uint256).max, block.timestamp + 1);
    }

    function test_Buy_RevertsOnExpiredDeadline() public {
        address token = _launch(RESEARCHER, "RX1");
        vm.prank(ALICE);
        etx.approve(address(markets), type(uint256).max);
        vm.warp(1000);
        vm.prank(ALICE);
        vm.expectRevert();
        markets.buy(token, 1_000 * ONE, 0, 999);
    }

    function test_Buy_RevertsOnUnknownMarket() public {
        vm.prank(ALICE);
        etx.approve(address(markets), type(uint256).max);
        vm.prank(ALICE);
        vm.expectRevert();
        markets.buy(address(0xBEEF), 1_000 * ONE, 0, block.timestamp + 1);
    }

    // ─── Sell ─────────────────────────────────────────────────────────

    function test_Sell_RoundTripsMinusFees() public {
        address token = _launch(RESEARCHER, "RX1");

        uint256 etxIn = 5_000 * ONE;

        vm.prank(ALICE);
        etx.approve(address(markets), type(uint256).max);
        vm.prank(ALICE);
        uint256 bought = markets.buy(token, etxIn, 0, block.timestamp + 1);
        assertGt(bought, 0);

        uint256 etxBefore = etx.balanceOf(ALICE);
        (uint256 expectedEtxOut, uint256 expectedFee) = markets.quoteSell(token, bought);
        assertGt(expectedEtxOut, 0);
        assertGt(expectedFee, 0);

        vm.prank(ALICE);
        uint256 got = markets.sell(token, bought, 0, block.timestamp + 1);

        assertEq(got, expectedEtxOut, "sell matches quote");
        assertEq(etx.balanceOf(ALICE), etxBefore + expectedEtxOut, "seller received net");
        assertEq(ResearchToken(token).balanceOf(ALICE), 0, "tokens burned");
        // Round-trip should be net-negative due to fees (1% in + 1% out)
        assertLt(expectedEtxOut, etxIn, "fees subtract from round-trip");
    }

    // ─── Graduation ───────────────────────────────────────────────────

    function test_Graduation_FiresAtThreshold() public {
        address token = _launch(RESEARCHER, "RX1");

        vm.prank(ALICE);
        etx.approve(address(markets), type(uint256).max);

        // Buy enough to cross the 100k ETX threshold.
        vm.prank(ALICE);
        markets.buy(token, 200_000 * ONE, 0, block.timestamp + 1);

        assertTrue(markets.isGraduated(token), "graduated");
        EticaResearchMarkets.MarketView memory v = markets.market(token);
        assertGt(v.graduatedAt, 0, "graduatedAt set");
        assertGe(v.virtualEtxAcc, GRAD_THRESHOLD, "acc above threshold");
    }

    function test_Graduation_DoesNotFireBelowThreshold() public {
        address token = _launch(RESEARCHER, "RX1");
        vm.prank(ALICE);
        etx.approve(address(markets), type(uint256).max);
        vm.prank(ALICE);
        markets.buy(token, 1_000 * ONE, 0, block.timestamp + 1);
        assertFalse(markets.isGraduated(token));
    }

    // ─── Sunset ───────────────────────────────────────────────────────

    function test_Sunset_FlipsAfter30Days() public {
        address token = _launch(RESEARCHER, "RX1");

        vm.prank(ALICE);
        etx.approve(address(markets), type(uint256).max);
        vm.prank(ALICE);
        markets.buy(token, 100 * ONE, 0, block.timestamp + 1);

        // Not yet sunsettable.
        vm.expectRevert();
        markets.markSunsetted(token);

        // Skip past the sunset window.
        vm.warp(block.timestamp + SUNSET_WINDOW + 1);
        markets.markSunsetted(token);
        assertTrue(markets.isSunsetted(token));

        // Auto-unsets on next trade.
        vm.prank(ALICE);
        markets.buy(token, 10 * ONE, 0, block.timestamp + 1);
        assertFalse(markets.isSunsetted(token));
    }

    function test_Sunset_AlreadySunsettedReverts() public {
        address token = _launch(RESEARCHER, "RX1");
        vm.prank(ALICE);
        etx.approve(address(markets), type(uint256).max);
        vm.prank(ALICE);
        markets.buy(token, 100 * ONE, 0, block.timestamp + 1);
        vm.warp(block.timestamp + SUNSET_WINDOW + 1);
        markets.markSunsetted(token);
        vm.expectRevert();
        markets.markSunsetted(token);
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function test_OnlyOwner_CanSetTreasury() public {
        vm.prank(ALICE);
        vm.expectRevert();
        markets.setTreasury(BOB);

        vm.prank(OWNER);
        markets.setTreasury(BOB);
        assertEq(markets.treasury(), BOB);
    }

    function test_OnlyOwner_CanSetFeeRate() public {
        vm.prank(OWNER);
        markets.setFeeRate(50);
        assertEq(markets.feeRateBps(), 50);

        vm.prank(OWNER);
        vm.expectRevert();
        markets.setFeeRate(501); // > MAX_FEE_BPS
    }

    function test_OnlyOwner_CanSetFeeSplit() public {
        vm.prank(OWNER);
        markets.setFeeSplit(2500, 2500, 500); // 25/25/5 → pool slice 45
        assertEq(markets.etiLpBps(), 2500);
        assertEq(markets.treasuryBps(), 2500);
        assertEq(markets.researcherBps(), 500);

        vm.prank(OWNER);
        vm.expectRevert();
        markets.setFeeSplit(4000, 4000, 4000); // sums to > BPS
    }

    function test_FreePool_TracksAttributedVsTotal() public {
        // Initial: 5_000_000 ETX seeded, 0 markets, 0 attributed.
        assertEq(markets.freePoolEtx(), 5_000_000 * ONE);

        address token = _launch(RESEARCHER, "RX1");
        // Launch toll lands in free pool: +100 ETX.
        assertEq(markets.freePoolEtx(), 5_000_100 * ONE);

        vm.prank(ALICE);
        etx.approve(address(markets), type(uint256).max);
        vm.prank(ALICE);
        markets.buy(token, 1_000 * ONE, 0, block.timestamp + 1);

        // After buy: 99% of 1_000 ETX = 990 ETX credited to market.
        // 80% of fee (80% of 10 = 8 ETX) stayed as free pool compound
        // under the C-with-lock split (1000/0/1000 = 80% residual pool).
        EticaResearchMarkets.MarketView memory v = markets.market(token);
        assertEq(v.virtualEtxAcc, 990 * ONE);
        assertEq(markets.freePoolEtx(), 5_000_100 * ONE + 8 * ONE);
    }

    // ─── Math invariant ───────────────────────────────────────────────

    function test_Curve_ConstantProductInvariantHolds() public {
        address token = _launch(RESEARCHER, "RX1");

        vm.prank(ALICE);
        etx.approve(address(markets), type(uint256).max);

        uint256 k = uint256(V_ETX_START) * uint256(V_TOKEN_START);

        // Run a sequence of buys; verify (vETXstart + acc) * (vTokenStart - supply) ≈ k.
        uint256[5] memory buys =
            [uint256(100 * ONE), 500 * ONE, 2_000 * ONE, 10_000 * ONE, 50_000 * ONE];
        for (uint256 i = 0; i < buys.length; i++) {
            vm.prank(ALICE);
            markets.buy(token, buys[i], 0, block.timestamp + 1);

            EticaResearchMarkets.MarketView memory v = markets.market(token);
            uint256 vETX = uint256(v.virtualEtxStart) + uint256(v.virtualEtxAcc);
            uint256 vTok = uint256(v.virtualTokenStart) - uint256(v.tokenSupply);
            uint256 prod = vETX * vTok;
            // Allow small rounding tolerance from integer division: |prod - k| / k < 1e-12.
            if (prod > k) {
                assertLt(prod - k, k / 1e12, "k drift up");
            } else {
                assertLt(k - prod, k / 1e12, "k drift down");
            }
        }
    }
}
