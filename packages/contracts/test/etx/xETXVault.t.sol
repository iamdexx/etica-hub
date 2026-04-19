// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ETXToken} from "../../src/etx/ETXToken.sol";
import {xETXVault} from "../../src/etx/xETXVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract xETXVaultTest is Test {
    ETXToken internal etx;
    MockERC20 internal eti;
    xETXVault internal vault;

    address internal owner = address(this);
    address internal distributor = address(0xD15);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        etx = new ETXToken(address(this));
        eti = new MockERC20("ETI", "ETI");

        vault = new xETXVault(IERC20(address(etx)), IERC20(address(eti)), owner);
        vault.setDistributor(distributor);

        etx.transfer(alice, 1_000 * 1e18);
        etx.transfer(bob, 1_000 * 1e18);

        vm.prank(alice);
        etx.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        etx.approve(address(vault), type(uint256).max);
    }

    function _notify(uint256 amount) internal {
        eti.mint(address(vault), amount);
        vm.prank(distributor);
        vault.notifyRewardAmount(amount);
    }

    function test_stake_mintsXetx() public {
        vm.prank(alice);
        vault.stake(100 * 1e18);
        assertEq(vault.balanceOf(alice), 100 * 1e18);
        assertEq(etx.balanceOf(alice), 900 * 1e18);
    }

    function test_nonTransferable() public {
        vm.prank(alice);
        vault.stake(100 * 1e18);
        vm.prank(alice);
        vm.expectRevert(bytes("xETX: non-transferable"));
        vault.transfer(bob, 10 * 1e18);
    }

    function test_earnsRewardsProRata() public {
        vm.prank(alice);
        vault.stake(100 * 1e18);
        vm.prank(bob);
        vault.stake(300 * 1e18);

        _notify(7_000 * 1e18); // 1000 ETI/day for 7 days
        vm.warp(block.timestamp + 7 days);

        uint256 aliceEarned = vault.earned(alice);
        uint256 bobEarned = vault.earned(bob);

        // alice: 1/4 of 7000 = 1750
        // bob: 3/4 of 7000 = 5250
        assertApproxEqAbs(aliceEarned, 1_750 * 1e18, 1e15);
        assertApproxEqAbs(bobEarned, 5_250 * 1e18, 1e15);
    }

    function test_claimReward_transfersEti() public {
        vm.prank(alice);
        vault.stake(100 * 1e18);
        _notify(700 * 1e18);
        vm.warp(block.timestamp + 7 days);

        vm.prank(alice);
        vault.claimReward();

        assertApproxEqAbs(eti.balanceOf(alice), 700 * 1e18, 1e15);
        assertEq(vault.earned(alice), 0);
    }

    function test_requestUnstake_startsCooldown() public {
        vm.prank(alice);
        vault.stake(100 * 1e18);

        vm.prank(alice);
        vault.requestUnstake(50 * 1e18);

        assertEq(vault.balanceOf(alice), 50 * 1e18); // xETX burned
        (uint128 amt, uint64 avail) = vault.unstakeRequests(alice);
        assertEq(amt, 50 * 1e18);
        assertEq(avail, uint64(block.timestamp + 7 days));
    }

    function test_withdraw_reverts_beforeCooldown() public {
        vm.prank(alice);
        vault.stake(100 * 1e18);
        vm.prank(alice);
        vault.requestUnstake(50 * 1e18);

        vm.warp(block.timestamp + 6 days);
        vm.prank(alice);
        vm.expectRevert(bytes("xETX: cooldown active"));
        vault.withdraw();
    }

    function test_withdraw_returnsEtx_afterCooldown() public {
        vm.prank(alice);
        vault.stake(100 * 1e18);
        vm.prank(alice);
        vault.requestUnstake(50 * 1e18);

        vm.warp(block.timestamp + 7 days + 1);

        vm.prank(alice);
        vault.withdraw();
        assertEq(etx.balanceOf(alice), 950 * 1e18);
    }

    function test_unstakedXetx_stopsEarning() public {
        vm.prank(alice);
        vault.stake(100 * 1e18);
        vm.prank(bob);
        vault.stake(100 * 1e18);

        // alice unstakes immediately
        vm.prank(alice);
        vault.requestUnstake(100 * 1e18);

        _notify(700 * 1e18);
        vm.warp(block.timestamp + 7 days);

        // bob has 100% of stake during reward period
        assertApproxEqAbs(vault.earned(bob), 700 * 1e18, 1e15);
        // alice's prior earned is still accrued but no new accrual
        assertLt(vault.earned(alice), 1e16);
    }

    function test_notifyRewardAmount_onlyDistributor() public {
        eti.mint(address(vault), 100 * 1e18);
        vm.prank(alice);
        vm.expectRevert(bytes("xETX: not distributor"));
        vault.notifyRewardAmount(100 * 1e18);
    }
}
