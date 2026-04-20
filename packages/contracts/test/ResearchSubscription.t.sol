// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ResearchSubscription} from "../src/research/ResearchSubscription.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract ResearchSubscriptionTest is Test {
    address internal constant OWNER = address(0xACE);
    address internal constant TREASURY = address(0xBEEF);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    uint256 internal constant PRICE = 5 ether; // 5 ETI / month

    MockERC20 internal eti;
    ResearchSubscription internal sub;

    function setUp() public {
        eti = new MockERC20("Etica (mock)", "ETI");
        sub = new ResearchSubscription(IERC20(address(eti)), TREASURY, PRICE, OWNER);

        eti.mint(ALICE, 1_000 ether);
        eti.mint(BOB, 1_000 ether);

        vm.prank(ALICE);
        eti.approve(address(sub), type(uint256).max);
        vm.prank(BOB);
        eti.approve(address(sub), type(uint256).max);
    }

    // ---------- constructor ----------

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(ResearchSubscription.ZeroAddress.selector);
        new ResearchSubscription(IERC20(address(0)), TREASURY, PRICE, OWNER);

        vm.expectRevert(ResearchSubscription.ZeroAddress.selector);
        new ResearchSubscription(IERC20(address(eti)), address(0), PRICE, OWNER);

        // Ownable's own guard fires first when owner==0
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ResearchSubscription(IERC20(address(eti)), TREASURY, PRICE, address(0));
    }

    // ---------- subscribe ----------

    function test_subscribe_oneMonth_transfersToTreasuryAndSetsExpiry() public {
        uint256 aliceBefore = eti.balanceOf(ALICE);
        uint256 treasuryBefore = eti.balanceOf(TREASURY);

        vm.warp(1_700_000_000);
        vm.prank(ALICE);
        sub.subscribe(1);

        assertEq(eti.balanceOf(ALICE), aliceBefore - PRICE, "alice balance");
        assertEq(eti.balanceOf(TREASURY), treasuryBefore + PRICE, "treasury balance");
        assertEq(sub.expiresAt(ALICE), 1_700_000_000 + 30 days, "expiry");
        assertTrue(sub.isActive(ALICE));
    }

    function test_subscribe_multipleMonths_multipliesPrice() public {
        vm.warp(1_700_000_000);
        vm.prank(ALICE);
        sub.subscribe(6);

        assertEq(eti.balanceOf(TREASURY), PRICE * 6);
        assertEq(sub.expiresAt(ALICE), 1_700_000_000 + 6 * 30 days);
    }

    function test_subscribe_extendsFromCurrentExpiryIfStillActive() public {
        vm.warp(1_700_000_000);
        vm.prank(ALICE);
        sub.subscribe(1); // expires at now + 30 days

        // still active, re-subscribe for another 2 months
        vm.warp(1_700_000_000 + 10 days);
        vm.prank(ALICE);
        sub.subscribe(2);

        // expiry extends from previous expiry, not from now
        assertEq(sub.expiresAt(ALICE), 1_700_000_000 + 30 days + 2 * 30 days);
    }

    function test_subscribe_restartsFromNowIfAlreadyExpired() public {
        vm.warp(1_700_000_000);
        vm.prank(ALICE);
        sub.subscribe(1);

        // warp past expiry and re-subscribe
        vm.warp(1_700_000_000 + 60 days);
        vm.prank(ALICE);
        sub.subscribe(1);

        assertEq(sub.expiresAt(ALICE), 1_700_000_000 + 60 days + 30 days);
    }

    function test_subscribe_revertsOnZeroMonths() public {
        vm.prank(ALICE);
        vm.expectRevert(ResearchSubscription.ZeroMonths.selector);
        sub.subscribe(0);
    }

    function test_subscribe_revertsOnTooManyMonths() public {
        vm.prank(ALICE);
        vm.expectRevert(ResearchSubscription.MonthsTooLarge.selector);
        sub.subscribe(25);
    }

    function test_subscribe_revertsWhenPriceZero() public {
        vm.prank(OWNER);
        sub.setPricePerMonth(0);

        vm.prank(ALICE);
        vm.expectRevert(ResearchSubscription.PriceNotSet.selector);
        sub.subscribe(1);
    }

    function test_isActive_falseBeforeSubscribe_trueDuring_falseAfter() public {
        assertFalse(sub.isActive(BOB));

        vm.warp(1_700_000_000);
        vm.prank(BOB);
        sub.subscribe(1);
        assertTrue(sub.isActive(BOB));

        vm.warp(1_700_000_000 + 30 days + 1);
        assertFalse(sub.isActive(BOB));
    }

    // ---------- admin ----------

    function test_setPricePerMonth_onlyOwner() public {
        vm.expectRevert();
        sub.setPricePerMonth(10 ether);

        vm.prank(OWNER);
        sub.setPricePerMonth(10 ether);
        assertEq(sub.pricePerMonth(), 10 ether);
    }

    function test_setTreasury_onlyOwner_andRejectsZero() public {
        vm.prank(OWNER);
        vm.expectRevert(ResearchSubscription.ZeroAddress.selector);
        sub.setTreasury(address(0));

        vm.prank(OWNER);
        sub.setTreasury(address(0x1234));
        assertEq(sub.treasury(), address(0x1234));

        // after rotation, new subscriptions route to new treasury
        vm.prank(ALICE);
        sub.subscribe(1);
        assertEq(eti.balanceOf(address(0x1234)), PRICE);
        assertEq(eti.balanceOf(TREASURY), 0);
    }
}
