// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ETXFarms} from "../../src/etx/ETXFarms.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract ETXFarmsTest is Test {
    MockERC20 internal etx;
    MockERC20 internal lpA; // stand-in for ETI/ETX LP
    MockERC20 internal lpB; // stand-in for EGAZ/ETX LP

    ETXFarms internal farms;

    address internal constant OWNER = address(0xAA);
    address internal constant TREASURY = address(0xBB); // fallback recipient
    address internal constant HARVESTER = address(0xCC);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    uint256 internal constant ONE = 1e18;

    function setUp() public {
        etx = new MockERC20("ETX", "ETX");
        lpA = new MockERC20("LP ETI/ETX", "ETI-ETX");
        lpB = new MockERC20("LP EGAZ/ETX", "EGAZ-ETX");

        farms = new ETXFarms(address(etx), TREASURY, OWNER);

        // Seed LP balances for the stakers.
        lpA.mint(ALICE, 1_000 * ONE);
        lpA.mint(BOB, 1_000 * ONE);
        lpB.mint(ALICE, 1_000 * ONE);
        lpB.mint(BOB, 1_000 * ONE);

        // Seed harvester with ETX for reward injection.
        etx.mint(HARVESTER, 1_000_000 * ONE);

        // Approvals.
        vm.prank(ALICE);
        lpA.approve(address(farms), type(uint256).max);
        vm.prank(ALICE);
        lpB.approve(address(farms), type(uint256).max);
        vm.prank(BOB);
        lpA.approve(address(farms), type(uint256).max);
        vm.prank(BOB);
        lpB.approve(address(farms), type(uint256).max);
        vm.prank(HARVESTER);
        etx.approve(address(farms), type(uint256).max);

        // Register two equal-weight pools (50/50 of the farms bucket).
        vm.prank(OWNER);
        farms.addPool(IERC20(address(lpA)), 5_000);
        vm.prank(OWNER);
        farms.addPool(IERC20(address(lpB)), 5_000);
    }

    // -------------------------------------------------------------------------
    // Metadata / shape
    // -------------------------------------------------------------------------

    function test_metadata() public view {
        assertEq(farms.rewardToken(), address(etx));
        assertEq(farms.fallbackRecipient(), TREASURY);
        assertEq(farms.owner(), OWNER);
        assertEq(farms.poolLength(), 2);
        assertEq(farms.totalAllocPoint(), 10_000);
    }

    function test_poolInfo_shape() public view {
        (IERC20 lp, uint256 alloc, uint256 totalStaked, uint256 acc) = farms.poolInfo(0);
        assertEq(address(lp), address(lpA));
        assertEq(alloc, 5_000);
        assertEq(totalStaked, 0);
        assertEq(acc, 0);
    }

    // -------------------------------------------------------------------------
    // Owner controls
    // -------------------------------------------------------------------------

    function test_addPool_onlyOwner() public {
        vm.prank(ALICE);
        vm.expectRevert();
        farms.addPool(IERC20(address(etx)), 1);
    }

    function test_addPool_cannotRegisterRewardToken() public {
        vm.prank(OWNER);
        vm.expectRevert(ETXFarms.CannotRescueStakedLp.selector);
        farms.addPool(IERC20(address(etx)), 1);
    }

    function test_addPool_cannotDoubleRegister() public {
        vm.prank(OWNER);
        vm.expectRevert(ETXFarms.LpAlreadyRegistered.selector);
        farms.addPool(IERC20(address(lpA)), 1);
    }

    function test_setAllocPoint_updatesTotal() public {
        vm.prank(OWNER);
        farms.setAllocPoint(0, 7_000);
        assertEq(farms.totalAllocPoint(), 12_000);
    }

    function test_setFallbackRecipient() public {
        vm.prank(OWNER);
        farms.setFallbackRecipient(address(0x999));
        assertEq(farms.fallbackRecipient(), address(0x999));
    }

    function test_setFallbackRecipient_zeroReverts() public {
        vm.prank(OWNER);
        vm.expectRevert(ETXFarms.ZeroAddress.selector);
        farms.setFallbackRecipient(address(0));
    }

    // -------------------------------------------------------------------------
    // Deposit / withdraw mechanics
    // -------------------------------------------------------------------------

    function test_deposit_incrementsTotalStaked() public {
        vm.prank(ALICE);
        farms.deposit(0, 100 * ONE);

        (,, uint256 totalStaked,) = farms.poolInfo(0);
        assertEq(totalStaked, 100 * ONE);
        assertEq(lpA.balanceOf(address(farms)), 100 * ONE);
        assertEq(lpA.balanceOf(ALICE), 900 * ONE);
    }

    function test_withdraw_returnsLp() public {
        vm.prank(ALICE);
        farms.deposit(0, 100 * ONE);
        vm.prank(ALICE);
        farms.withdraw(0, 40 * ONE);
        assertEq(lpA.balanceOf(ALICE), 940 * ONE);

        (,, uint256 totalStaked,) = farms.poolInfo(0);
        assertEq(totalStaked, 60 * ONE);
    }

    function test_withdraw_tooMuchReverts() public {
        vm.prank(ALICE);
        farms.deposit(0, 100 * ONE);
        vm.prank(ALICE);
        vm.expectRevert(ETXFarms.InsufficientStake.selector);
        farms.withdraw(0, 101 * ONE);
    }

    function test_deposit_zeroReverts() public {
        vm.prank(ALICE);
        vm.expectRevert(ETXFarms.ZeroAmount.selector);
        farms.deposit(0, 0);
    }

    function test_emergencyWithdraw_returnsLpForfeitsRewards() public {
        vm.prank(ALICE);
        farms.deposit(0, 100 * ONE);

        // Inject a reward while Alice is alone in the pool.
        vm.prank(HARVESTER);
        farms.distributeRewards(100 * ONE);

        vm.prank(ALICE);
        farms.emergencyWithdraw(0);

        assertEq(lpA.balanceOf(ALICE), 1_000 * ONE);
        // She forfeited the 50 ETX share (half of 100 went to pool 0).
        assertEq(etx.balanceOf(ALICE), 0);
    }

    // -------------------------------------------------------------------------
    // Reward accumulator math
    // -------------------------------------------------------------------------

    function test_distributeRewards_zeroReverts() public {
        vm.prank(HARVESTER);
        vm.expectRevert(ETXFarms.ZeroAmount.selector);
        farms.distributeRewards(0);
    }

    function test_distributeRewards_soloStaker_getsPoolShare() public {
        // Alice stakes in pool 0 only.
        vm.prank(ALICE);
        farms.deposit(0, 100 * ONE);

        // Harvester injects 100 ETX. Pool 0 (5000/10000) = 50, pool 1 = 50.
        // Pool 1 has 0 stake so its 50 is forwarded to treasury fallback.
        vm.prank(HARVESTER);
        farms.distributeRewards(100 * ONE);

        assertEq(etx.balanceOf(TREASURY), 50 * ONE, "fallback got empty pool share");
        assertEq(farms.pendingReward(0, ALICE), 50 * ONE);
        assertEq(farms.pendingReward(1, ALICE), 0);

        vm.prank(ALICE);
        farms.harvest(0);
        assertEq(etx.balanceOf(ALICE), 50 * ONE);
    }

    function test_distributeRewards_twoStakers_proRata() public {
        vm.prank(ALICE);
        farms.deposit(0, 100 * ONE);
        vm.prank(BOB);
        farms.deposit(0, 300 * ONE); // Bob has 3x Alice's stake.

        // Also stake in pool 1 so nothing goes to fallback.
        vm.prank(ALICE);
        farms.deposit(1, 1 * ONE);

        vm.prank(HARVESTER);
        farms.distributeRewards(80 * ONE);

        // Pool 0 gets 40 ETX split 1:3 -> Alice 10, Bob 30.
        // Pool 1 gets 40 ETX all to Alice.
        assertEq(farms.pendingReward(0, ALICE), 10 * ONE);
        assertEq(farms.pendingReward(0, BOB), 30 * ONE);
        assertEq(farms.pendingReward(1, ALICE), 40 * ONE);

        vm.prank(ALICE);
        farms.harvest(0);
        vm.prank(ALICE);
        farms.harvest(1);
        vm.prank(BOB);
        farms.harvest(0);

        assertEq(etx.balanceOf(ALICE), 50 * ONE);
        assertEq(etx.balanceOf(BOB), 30 * ONE);
    }

    function test_distributeRewards_multipleCallsAccumulate() public {
        vm.prank(ALICE);
        farms.deposit(0, 100 * ONE);
        vm.prank(ALICE);
        farms.deposit(1, 100 * ONE);

        // First harvest: 200 ETX -> 100 to each pool -> 100 each to Alice.
        vm.prank(HARVESTER);
        farms.distributeRewards(200 * ONE);
        // Second harvest: 60 ETX -> 30 to each pool.
        vm.prank(HARVESTER);
        farms.distributeRewards(60 * ONE);

        assertEq(farms.pendingReward(0, ALICE), 130 * ONE);
        assertEq(farms.pendingReward(1, ALICE), 130 * ONE);
    }

    function test_distributeRewards_lateJoinerDoesNotClaimPast() public {
        vm.prank(ALICE);
        farms.deposit(0, 100 * ONE);
        // Also make pool 1 non-empty so nothing leaks to fallback.
        vm.prank(ALICE);
        farms.deposit(1, 1 * ONE);

        vm.prank(HARVESTER);
        farms.distributeRewards(100 * ONE); // Alice gets 50 in pool 0, 50 in pool 1.

        // Bob enters pool 0 AFTER the reward.
        vm.prank(BOB);
        farms.deposit(0, 100 * ONE);

        assertEq(farms.pendingReward(0, ALICE), 50 * ONE);
        assertEq(farms.pendingReward(0, BOB), 0, "late joiner claims nothing from past rewards");

        // Next distribution should split pool 0 50/50.
        vm.prank(HARVESTER);
        farms.distributeRewards(200 * ONE); // pool 0 gets 100, pool 1 gets 100.

        assertEq(farms.pendingReward(0, ALICE), 50 * ONE + 50 * ONE);
        assertEq(farms.pendingReward(0, BOB), 50 * ONE);
        assertEq(farms.pendingReward(1, ALICE), 50 * ONE + 100 * ONE);
    }

    function test_distributeRewards_bothPoolsEmpty_allFallback() public {
        // No one staked anywhere.
        vm.prank(HARVESTER);
        farms.distributeRewards(100 * ONE);
        assertEq(etx.balanceOf(TREASURY), 100 * ONE);
    }

    function test_deposit_thenAutoHarvestsOnSecondDeposit() public {
        vm.prank(ALICE);
        farms.deposit(0, 100 * ONE);
        vm.prank(ALICE);
        farms.deposit(1, 1 * ONE); // make pool 1 non-empty

        vm.prank(HARVESTER);
        farms.distributeRewards(100 * ONE); // Alice earns 50 in pool 0

        assertEq(farms.pendingReward(0, ALICE), 50 * ONE);

        vm.prank(ALICE);
        farms.deposit(0, 50 * ONE); // should auto-harvest the 50
        assertEq(etx.balanceOf(ALICE), 50 * ONE);
        assertEq(farms.pendingReward(0, ALICE), 0);
    }

    function test_withdraw_autoHarvests() public {
        vm.prank(ALICE);
        farms.deposit(0, 100 * ONE);
        vm.prank(ALICE);
        farms.deposit(1, 1 * ONE);

        vm.prank(HARVESTER);
        farms.distributeRewards(100 * ONE);

        vm.prank(ALICE);
        farms.withdraw(0, 100 * ONE);

        assertEq(lpA.balanceOf(ALICE), 1_000 * ONE);
        assertEq(etx.balanceOf(ALICE), 50 * ONE);
    }

    // -------------------------------------------------------------------------
    // Rescue guards
    // -------------------------------------------------------------------------

    function test_rescueToken_cannotRescueRewardToken() public {
        vm.prank(OWNER);
        vm.expectRevert(ETXFarms.CannotRescueRewardToken.selector);
        farms.rescueToken(IERC20(address(etx)), OWNER, 1);
    }

    function test_rescueToken_cannotRescueLp() public {
        vm.prank(OWNER);
        vm.expectRevert(ETXFarms.CannotRescueStakedLp.selector);
        farms.rescueToken(IERC20(address(lpA)), OWNER, 1);
    }

    function test_rescueToken_unrelatedTokenAllowed() public {
        MockERC20 junk = new MockERC20("Junk", "JUNK");
        junk.mint(address(farms), 500 * ONE);

        vm.prank(OWNER);
        farms.rescueToken(IERC20(address(junk)), OWNER, 500 * ONE);
        assertEq(junk.balanceOf(OWNER), 500 * ONE);
    }

    // -------------------------------------------------------------------------
    // Harvester interface parity
    // -------------------------------------------------------------------------

    /// @notice Reward injection is permissionless — anyone can top up, matching
    ///         the permissionless stETX.distributeRewards pattern.
    function test_distributeRewards_isPermissionless() public {
        vm.prank(ALICE);
        farms.deposit(0, 100 * ONE);

        // BOB (not the harvester) can also distribute.
        etx.mint(BOB, 100 * ONE);
        vm.prank(BOB);
        etx.approve(address(farms), 100 * ONE);

        vm.prank(BOB);
        farms.distributeRewards(100 * ONE);

        // Alice alone in pool 0 → earns 50; pool 1 empty → 50 to fallback.
        assertEq(farms.pendingReward(0, ALICE), 50 * ONE);
        assertEq(etx.balanceOf(TREASURY), 50 * ONE);
    }
}
