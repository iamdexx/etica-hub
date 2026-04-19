// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ETXToken} from "../../src/etx/ETXToken.sol";
import {MasterChef} from "../../src/etx/MasterChef.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract MasterChefTest is Test {
    ETXToken internal etx;
    MockERC20 internal lp;
    MasterChef internal chef;

    address internal owner = address(this);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint256 internal constant ETX_PER_SECOND = 1e18; // 1 ETX/sec for easy math

    function setUp() public {
        etx = new ETXToken(address(this));
        lp = new MockERC20("LP", "LP");

        chef = new MasterChef(IERC20(address(etx)), ETX_PER_SECOND, uint64(block.timestamp), owner);
        etx.transfer(address(chef), 70_000_000 * 1e18);

        chef.add(100, IERC20(address(lp)));

        lp.mint(alice, 1_000 * 1e18);
        lp.mint(bob, 1_000 * 1e18);

        vm.prank(alice);
        lp.approve(address(chef), type(uint256).max);
        vm.prank(bob);
        lp.approve(address(chef), type(uint256).max);
    }

    function test_singleStaker_earnsEmittedRewards() public {
        vm.prank(alice);
        chef.deposit(0, 100 * 1e18);

        vm.warp(block.timestamp + 10);
        uint256 pending = chef.pendingEtx(0, alice);
        assertApproxEqAbs(pending, 10 * 1e18, 1e12);

        vm.prank(alice);
        chef.harvest(0);
        assertApproxEqAbs(etx.balanceOf(alice), 10 * 1e18, 1e12);
    }

    function test_twoStakers_splitRewardsProRata() public {
        vm.prank(alice);
        chef.deposit(0, 100 * 1e18);
        vm.prank(bob);
        chef.deposit(0, 300 * 1e18); // bob has 3x alice

        vm.warp(block.timestamp + 100);

        uint256 aliceP = chef.pendingEtx(0, alice);
        uint256 bobP = chef.pendingEtx(0, bob);

        // alice = 100 * 1/4 = 25 ETX, bob = 100 * 3/4 = 75 ETX
        assertApproxEqAbs(aliceP, 25 * 1e18, 1e15);
        assertApproxEqAbs(bobP, 75 * 1e18, 1e15);
    }

    function test_withdraw_returnsLpAndHarvests() public {
        vm.prank(alice);
        chef.deposit(0, 100 * 1e18);

        vm.warp(block.timestamp + 50);

        vm.prank(alice);
        chef.withdraw(0, 100 * 1e18);

        assertEq(lp.balanceOf(alice), 1_000 * 1e18);
        assertGt(etx.balanceOf(alice), 0);
    }

    function test_addDuplicateLp_reverts() public {
        vm.expectRevert(bytes("MC: lp exists"));
        chef.add(50, IERC20(address(lp)));
    }

    function test_onlyOwnerCanAdd() public {
        MockERC20 other = new MockERC20("O", "O");
        vm.prank(alice);
        vm.expectRevert();
        chef.add(10, IERC20(address(other)));
    }

    function test_emergencyWithdraw_returnsLpEvenIfEtxDepleted() public {
        vm.prank(alice);
        chef.deposit(0, 100 * 1e18);

        // drain ETX
        uint256 chefBal = etx.balanceOf(address(chef));
        vm.prank(address(chef));
        etx.transfer(address(0xdead), chefBal);

        vm.prank(alice);
        chef.emergencyWithdraw(0);

        assertEq(lp.balanceOf(alice), 1_000 * 1e18);
    }
}
