// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EticaStableSwap} from "../../src/stableswap/EticaStableSwap.sol";
import {LiquidityTimelock10y} from "../../src/stableswap/LiquidityTimelock10y.sol";
import {
    StableSwapHarvesterAdapter,
    IStableSwap
} from "../../src/stableswap/StableSwapHarvesterAdapter.sol";
import {StakedETX} from "../../src/etx/StakedETX.sol";
import {ETXToken} from "../../src/etx/ETXToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @title EticaStableSwap end-to-end tests
/// @notice Covers rate-aware math, NAV drift, A-ramp invariants, swap edges,
///         fee accumulation + claim, public LPs are unaffected by the
///         treasury timelock, and the harvester adapter's 10/10/40/40 split.
contract EticaStableSwapTest is Test {
    ETXToken internal etx;
    StakedETX internal stEtx;
    EticaStableSwap internal pool;
    LiquidityTimelock10y internal timelock;
    StableSwapHarvesterAdapter internal adapter;

    address internal constant TREASURY = address(0x7);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA8014);
    address internal constant FARMS_SINK = address(0xFA8);
    address internal constant TREASURY_WALLET = address(0xDEEDBEEF);

    uint256 internal constant ONE = 1e18;
    uint256 internal constant SEED_ETX = 15_000_000 * ONE;
    uint256 internal constant SEED_STETX = 15_000_000 * ONE;

    function setUp() public {
        etx = new ETXToken(TREASURY);
        stEtx = new StakedETX(IERC20(address(etx)));
        pool = new EticaStableSwap(IERC20(address(etx)), IERC4626(address(stEtx)), 200, TREASURY);

        // Distribute test funds.
        vm.startPrank(TREASURY);
        etx.transfer(ALICE, 1_000_000 * ONE);
        etx.transfer(BOB, 1_000_000 * ONE);
        etx.transfer(CAROL, 1_000_000 * ONE);
        // Treasury keeps the rest (~97M) for seeding.
        vm.stopPrank();

        // Approvals.
        _approveAll(TREASURY);
        _approveAll(ALICE);
        _approveAll(BOB);
        _approveAll(CAROL);
    }

    function _approveAll(address who) internal {
        vm.startPrank(who);
        etx.approve(address(pool), type(uint256).max);
        etx.approve(address(stEtx), type(uint256).max);
        stEtx.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    function _seedTreasury() internal returns (uint256 lp) {
        vm.startPrank(TREASURY);
        // Stake half of the 30M-ETX commitment into stETX vault to get stETX.
        stEtx.deposit(SEED_ETX, TREASURY);
        // Create the timelock and seed the pool.
        timelock = new LiquidityTimelock10y(TREASURY, IERC20(address(pool)));
        lp = pool.addLiquidity(SEED_ETX, SEED_STETX, 0, address(timelock));
        timelock.setLockedAmount(lp);
        vm.stopPrank();
    }

    function _addPublicLp(address who, uint256 amountEtx, uint256 amountStEtx)
        internal
        returns (uint256 lp)
    {
        vm.startPrank(who);
        if (amountStEtx != 0) {
            stEtx.deposit(amountStEtx, who);
        }
        lp = pool.addLiquidity(amountEtx, amountStEtx, 0, who);
        vm.stopPrank();
    }

    function _bumpNav(uint256 rewardEtx) internal {
        // Inject rewards directly into the vault from the treasury.
        vm.startPrank(TREASURY);
        etx.approve(address(stEtx), rewardEtx);
        stEtx.distributeRewards(rewardEtx);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------
    // Construction & metadata
    // -------------------------------------------------------------------------

    function test_metadata() public view {
        assertEq(pool.name(), "EticaStableSwap stETX/ETX LP");
        assertEq(pool.symbol(), "esLP");
        assertEq(address(pool.etx()), address(etx));
        assertEq(address(pool.stEtx()), address(stEtx));
        assertEq(pool.swapFeeBps(), 4);
        assertEq(pool.adminFeeBps(), 5_000);
        assertEq(pool.getA(), 200 * 100); // scaled by A_PRECISION
    }

    function test_construct_revertsOnAssetMismatch() public {
        // Build a fake stETX whose asset() is NOT etx.
        ETXToken otherUnderlying = new ETXToken(TREASURY);
        StakedETX otherVault = new StakedETX(IERC20(address(otherUnderlying)));
        vm.expectRevert(EticaStableSwap.AssetMismatch.selector);
        new EticaStableSwap(IERC20(address(etx)), IERC4626(address(otherVault)), 200, TREASURY);
    }

    function test_construct_revertsOnZeroA() public {
        vm.expectRevert(EticaStableSwap.InvalidA.selector);
        new EticaStableSwap(IERC20(address(etx)), IERC4626(address(stEtx)), 0, TREASURY);
    }

    // -------------------------------------------------------------------------
    // Initial seeding
    // -------------------------------------------------------------------------

    function test_seed_mintsLpToTimelock() public {
        uint256 lp = _seedTreasury();
        // LP roughly equals xp[0] + xp[1] minus the dead lock (1000 wei).
        // At deploy NAV = 1.0, so xp[0] = 15M ETX, xp[1] = 15M ETX-equivalent.
        assertApproxEqAbs(lp, 30_000_000 * ONE, 1_000);
        assertEq(pool.balanceOf(address(timelock)), lp);
        assertEq(pool.balanceOf(address(0xdead)), 1_000);
        assertEq(pool.reserveEtx(), SEED_ETX);
        assertEq(pool.reserveStEtx(), SEED_STETX);
    }

    function test_seed_revertsOnImbalanced() public {
        vm.startPrank(TREASURY);
        stEtx.deposit(SEED_ETX, TREASURY);
        // Try to seed with a wildly imbalanced ratio.
        vm.expectRevert(EticaStableSwap.InitialDepositImbalanced.selector);
        pool.addLiquidity(SEED_ETX, SEED_STETX / 2, 0, TREASURY);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------
    // Public LPs unaffected by timelock
    // -------------------------------------------------------------------------

    function test_publicLp_canAddAndRemoveAnytime() public {
        _seedTreasury();

        uint256 amount = 100 * ONE;
        uint256 lp = _addPublicLp(ALICE, amount, amount);
        assertGt(lp, 0);
        assertEq(pool.balanceOf(ALICE), lp);

        // Alice withdraws the full position immediately. No lock.
        vm.startPrank(ALICE);
        (uint256 outEtx, uint256 outStEtx) = pool.removeLiquidity(lp, 0, 0, ALICE);
        vm.stopPrank();
        assertGt(outEtx, 0);
        assertGt(outStEtx, 0);
        assertEq(pool.balanceOf(ALICE), 0);
    }

    function test_publicLp_canRemoveOneCoinAnytime() public {
        _seedTreasury();
        uint256 amount = 1_000 * ONE;
        uint256 lp = _addPublicLp(ALICE, amount, amount);

        vm.startPrank(ALICE);
        uint256 etxBefore = etx.balanceOf(ALICE);
        uint256 received = pool.removeLiquidityOneCoin(0, lp, 0, ALICE);
        vm.stopPrank();
        assertGt(received, 0);
        assertEq(etx.balanceOf(ALICE) - etxBefore, received);
    }

    // -------------------------------------------------------------------------
    // Swap math at peg
    // -------------------------------------------------------------------------

    function test_swap_atPeg_almostNoSlippage() public {
        _seedTreasury();
        uint256 dx = 10_000 * ONE; // 10K ETX vs 30M pool — tiny

        vm.startPrank(ALICE);
        uint256 dy = pool.swap(0, 1, dx, 0, ALICE);
        vm.stopPrank();

        // Expect output ≈ input (within fees + 1bp slippage).
        // 4 bps fee ⇒ dy ≥ dx · (1 - 0.0004 - 0.0001) ≈ 0.9995 · dx
        assertGe(dy, (dx * 9_993) / 10_000);
        // And ≤ dx · 1.0 (can't exceed input at peg).
        assertLe(dy, dx);
    }

    function test_swap_navDrift_outputTracksRate() public {
        _seedTreasury();
        // Bump NAV: distribute 30M · 0.05 = 1.5M ETX → +5% NAV.
        _bumpNav((SEED_ETX * 5) / 100);
        uint256 rate = pool.getRate();
        assertApproxEqRel(rate, (105 * ONE) / 100, 0.001e18);

        // Swap 1k stETX → ETX. Expect ~1k * rate (minus fee).
        uint256 dx = 1_000 * ONE;
        // Make sure ALICE has stETX.
        vm.startPrank(ALICE);
        stEtx.deposit(2_000 * ONE, ALICE);
        uint256 dy = pool.swap(1, 0, dx, 0, ALICE);
        vm.stopPrank();

        uint256 expectedRaw = (dx * rate) / ONE;
        // Allow 1% slack for curve slippage + fees on a 5% drifted pool.
        assertApproxEqRel(dy, expectedRaw, 0.01e18);
    }

    // -------------------------------------------------------------------------
    // Fee accumulation & claim
    // -------------------------------------------------------------------------

    function test_swap_accumulatesAdminFee() public {
        _seedTreasury();
        uint256 dx = 10_000 * ONE;

        vm.startPrank(ALICE);
        pool.swap(0, 1, dx, 0, ALICE);
        vm.stopPrank();

        // Admin fee accumulator should be non-zero on the OUTPUT leg (stETX
        // for an ETX→stETX swap).
        assertEq(pool.adminFeeEtx(), 0);
        assertGt(pool.adminFeeStEtx(), 0);
        // Admin fee ≈ dx · 4bps · 50% ≈ 2 bps of dx (in stETX terms).
        // 4 bps of 10k = 4 ETX ⇒ 50% admin = 2 ETX → ~2 stETX at NAV 1.
        assertApproxEqAbs(pool.adminFeeStEtx(), 2 * ONE, 0.05e18);
    }

    function test_claimAdminFees_toRecipient() public {
        _seedTreasury();
        // Generate some fees via a swap.
        vm.startPrank(ALICE);
        pool.swap(0, 1, 100_000 * ONE, 0, ALICE);
        vm.stopPrank();

        // No recipient set yet ⇒ revert.
        vm.expectRevert(EticaStableSwap.ZeroAddress.selector);
        pool.claimAdminFees();

        // Set recipient and claim.
        vm.prank(TREASURY);
        pool.setAdminFeeRecipient(TREASURY_WALLET);

        uint256 stEtxBefore = stEtx.balanceOf(TREASURY_WALLET);
        (uint256 outEtx, uint256 outStEtx) = pool.claimAdminFees();
        assertEq(outEtx, 0);
        assertGt(outStEtx, 0);
        assertEq(stEtx.balanceOf(TREASURY_WALLET) - stEtxBefore, outStEtx);
        assertEq(pool.adminFeeStEtx(), 0);
    }

    // -------------------------------------------------------------------------
    // A-coefficient ramp safety
    // -------------------------------------------------------------------------

    function test_rampA_movesLinearly() public {
        _seedTreasury();
        uint256 startA = pool.getA();

        // Skip past the 1-day cooldown.
        vm.warp(block.timestamp + 2 days);

        vm.prank(TREASURY);
        pool.rampA(400, block.timestamp + 7 days);
        // Halfway through the ramp window, A should be ~ midway.
        vm.warp(block.timestamp + 3.5 days);
        uint256 midA = pool.getA();
        assertGt(midA, startA);
        assertLt(midA, 400 * 100);

        // After window, A is at target.
        vm.warp(block.timestamp + 4 days);
        assertEq(pool.getA(), 400 * 100);
    }

    function test_rampA_revertsOnMaxChange() public {
        _seedTreasury();
        vm.warp(block.timestamp + 2 days);
        // Ratio uses integer division; need newAreal >= 11 * 200 = 2200 for
        // newAscaled / currentA > MAX_A_CHANGE (10).
        vm.prank(TREASURY);
        vm.expectRevert();
        pool.rampA(2_201, block.timestamp + 7 days);
    }

    function test_rampA_revertsOnShortWindow() public {
        _seedTreasury();
        vm.warp(block.timestamp + 2 days);
        vm.prank(TREASURY);
        vm.expectRevert();
        pool.rampA(400, block.timestamp + 1 hours);
    }

    // -------------------------------------------------------------------------
    // Fee parameter caps
    // -------------------------------------------------------------------------

    function test_setSwapFee_capped() public {
        _seedTreasury();
        vm.prank(TREASURY);
        vm.expectRevert();
        pool.setSwapFee(101); // > 1%

        vm.prank(TREASURY);
        pool.setSwapFee(50);
        assertEq(pool.swapFeeBps(), 50);
    }

    function test_setAdminFee_capped() public {
        _seedTreasury();
        vm.prank(TREASURY);
        vm.expectRevert();
        pool.setAdminFee(10_001);
    }

    function test_setAdminFeeRecipient_zeroReverts() public {
        _seedTreasury();
        vm.prank(TREASURY);
        vm.expectRevert(EticaStableSwap.ZeroAddress.selector);
        pool.setAdminFeeRecipient(address(0));
    }

    // -------------------------------------------------------------------------
    // LiquidityTimelock10y
    // -------------------------------------------------------------------------

    function test_timelock_lockedTokenCannotMoveBeforeUnlock() public {
        uint256 lp = _seedTreasury();
        // Treasury cannot pull locked LP early.
        vm.prank(TREASURY);
        vm.expectRevert();
        timelock.lockedWithdraw(TREASURY, lp);

        // Even partial withdraws of the locked floor revert.
        vm.prank(TREASURY);
        vm.expectRevert();
        timelock.lockedWithdraw(TREASURY, 1);
    }

    function test_timelock_excessIsFreelyWithdrawable() public {
        _seedTreasury();
        // Send extra LP into the timelock by having Alice deposit and gift
        // her LP shares to the timelock.
        uint256 amount = 100 * ONE;
        uint256 aliceLp = _addPublicLp(ALICE, amount, amount);
        vm.prank(ALICE);
        pool.transfer(address(timelock), aliceLp);

        // Now the timelock has lockedAmount + aliceLp. Excess = aliceLp.
        assertEq(timelock.freeBalance(), aliceLp);

        vm.prank(TREASURY);
        timelock.withdrawExcess(TREASURY, aliceLp);
        assertEq(pool.balanceOf(TREASURY), aliceLp);
    }

    function test_timelock_unlocksAtTenYears() public {
        uint256 lp = _seedTreasury();
        vm.warp(timelock.unlockTime());
        vm.prank(TREASURY);
        timelock.lockedWithdraw(TREASURY, lp);
        assertEq(pool.balanceOf(TREASURY), lp);
        assertEq(timelock.lockedAmount(), 0);
    }

    function test_timelock_canRescueOtherTokens() public {
        _seedTreasury();
        // Pretend a stray ETX transfer landed in the timelock (e.g.
        // accidental routing). It must be rescuable any time.
        vm.prank(TREASURY);
        etx.transfer(address(timelock), 5 * ONE);

        vm.prank(TREASURY);
        timelock.rescue(IERC20(address(etx)), TREASURY_WALLET, 5 * ONE);
        assertEq(etx.balanceOf(TREASURY_WALLET), 5 * ONE);
    }

    function test_timelock_cannotRescueLockedLp() public {
        _seedTreasury();
        vm.prank(TREASURY);
        vm.expectRevert(LiquidityTimelock10y.CannotRescueLockedToken.selector);
        timelock.rescue(IERC20(address(pool)), TREASURY, 1);
    }

    function test_timelock_cannotIncreaseLockedAmount() public {
        _seedTreasury();
        // Owner sets locked = current. Then tries to increase it. Reverts.
        uint256 cur = timelock.lockedAmount();
        // Send extra LP so balanceOf > cur.
        uint256 extra = _addPublicLp(ALICE, 100 * ONE, 100 * ONE);
        vm.prank(ALICE);
        pool.transfer(address(timelock), extra);

        vm.prank(TREASURY);
        vm.expectRevert(LiquidityTimelock10y.CannotIncreaseLockMidLife.selector);
        timelock.setLockedAmount(cur + extra);
    }

    // -------------------------------------------------------------------------
    // StableSwapHarvesterAdapter — end-to-end split
    // -------------------------------------------------------------------------

    MockSink internal mockStakedSink;

    function _wireAdapter() internal {
        mockStakedSink = new MockSink(IERC20(address(etx)));
        adapter = new StableSwapHarvesterAdapter(
            TREASURY,
            IStableSwap(address(pool)),
            IERC20(address(etx)),
            IERC4626(address(stEtx)),
            address(mockStakedSink),
            address(0), // no farms wired in this test
            TREASURY_WALLET
        );
        vm.prank(TREASURY);
        pool.setAdminFeeRecipient(address(adapter));
    }

    function test_adapter_splits_10_10_40_40() public {
        _seedTreasury();
        _wireAdapter();

        // Generate fees via a swap.
        vm.startPrank(ALICE);
        pool.swap(0, 1, 100_000 * ONE, 0, ALICE);
        vm.stopPrank();

        uint256 stakedBefore = mockStakedSink.totalReceived();
        uint256 treasuryBefore = etx.balanceOf(TREASURY_WALLET);
        uint256 deadLpBefore = pool.balanceOf(adapter.DEAD());

        (uint256 totalEtx, uint256 polLpBurned) = adapter.harvest();

        // Total harvested ≈ admin slice of fee. swap=100k ETX in stETX leg
        // ⇒ ~20 stETX admin fee ⇒ ~20 ETX after redemption (rate=1 at deploy).
        assertApproxEqAbs(totalEtx, 20 * ONE, 1 ether);
        // Mock staked sink got ~10% of total.
        assertApproxEqRel(mockStakedSink.totalReceived() - stakedBefore, totalEtx / 10, 0.05e18);
        // Treasury got >= 40% (40% real + 10% fold-back from missing farms sink).
        assertGe(etx.balanceOf(TREASURY_WALLET) - treasuryBefore, (totalEtx * 50) / 100);
        // Some POL LP was permanently burned (40% slice paired into the pool).
        assertGt(polLpBurned, 0);
        assertEq(pool.balanceOf(adapter.DEAD()) - deadLpBefore, polLpBurned);
    }

    function test_adapter_revertsWhenNothingToHarvest() public {
        _seedTreasury();
        _wireAdapter();
        vm.expectRevert(StableSwapHarvesterAdapter.NothingToHarvest.selector);
        adapter.harvest();
    }

    function test_adapter_setSplit_mustSumTo10000() public {
        _seedTreasury();
        _wireAdapter();
        vm.prank(TREASURY);
        vm.expectRevert(StableSwapHarvesterAdapter.BpsSumInvalid.selector);
        adapter.setSplit(1, 1, 1, 1);

        vm.prank(TREASURY);
        adapter.setSplit(2_000, 2_000, 3_000, 3_000); // 20/20/30/30
        assertEq(adapter.stakedEtxBps(), 2_000);
    }

    function test_adapter_treasuryLpStaysLocked_afterMultipleHarvests() public {
        uint256 initialLp = _seedTreasury();
        _wireAdapter();

        // Drive 5 swap+harvest cycles. Bob mints stETX from the vault
        // first so he can swap the stETX→ETX leg.
        vm.prank(BOB);
        stEtx.deposit(500_000 * ONE, BOB);
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(ALICE);
            pool.swap(0, 1, 50_000 * ONE, 0, ALICE);
            vm.prank(BOB);
            pool.swap(1, 0, 50_000 * ONE, 0, BOB);
            adapter.harvest();
        }

        // Treasury LP balance in the timelock is unchanged. Fees flowed
        // entirely through the adapter; principal stays put.
        assertEq(pool.balanceOf(address(timelock)), initialLp);
        // Locked floor unchanged.
        assertEq(timelock.lockedAmount(), initialLp);
    }
}

/// @notice Minimal mock implementing IRewardSink for adapter tests. Pulls
///         ETX into itself and tracks the cumulative amount received.
contract MockSink {
    IERC20 public immutable token;
    uint256 public totalReceived;

    constructor(IERC20 _token) {
        token = _token;
    }

    function distributeRewards(uint256 amount) external {
        require(token.transferFrom(msg.sender, address(this), amount), "pull failed");
        totalReceived += amount;
    }
}
