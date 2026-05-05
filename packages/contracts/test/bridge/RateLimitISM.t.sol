// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {RateLimitISM} from "../../src/bridge/RateLimitISM.sol";
import {BridgeMessage} from "../../src/bridge/IBridgeMinter.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract RateLimitISMTest is Test {
    RateLimitISM internal ism;

    address internal constant OWNER = address(0x0117E2);
    address internal constant MAILBOX = address(0xA17BAA);
    address internal constant ATTACKER = address(0xBAD);

    uint64 internal constant TIMELOCK = 24 hours;
    uint128 internal constant DAILY_CAP = 50_000 ether;

    function setUp() public {
        ism = new RateLimitISM(OWNER, MAILBOX, DAILY_CAP, TIMELOCK);
        // Pin block.timestamp so day boundaries are predictable.
        vm.warp(1_700_000_000);
    }

    /* -------------------------------------------------------------------- */
    /*                                HELPERS                               */
    /* -------------------------------------------------------------------- */

    function _msg(uint128 amount) internal view returns (bytes memory) {
        BridgeMessage memory m = BridgeMessage({
            nonce: bytes32(uint256(amount)),
            srcDomain: 61803,
            destDomain: 1,
            sender: address(0xCAFE),
            recipient: address(0xBEEF),
            amount: amount,
            srcBlockNumber: 12345,
            timestamp: uint64(block.timestamp)
        });
        bytes memory header = new bytes(77);
        return bytes.concat(header, abi.encode(m));
    }

    function _verifyAs(address caller, uint128 amount) internal returns (bool) {
        vm.prank(caller);
        return ism.verify("", _msg(amount));
    }

    function _wireDailyCap(uint128 newCap) internal {
        vm.prank(OWNER);
        uint256 id = ism.requestSetDailyCap(newCap);
        vm.warp(block.timestamp + TIMELOCK);
        vm.prank(OWNER);
        ism.executeOp(id);
    }

    /* -------------------------------------------------------------------- */
    /*                            CONSTRUCTOR                               */
    /* -------------------------------------------------------------------- */

    function test_constructor_setsState() public view {
        assertEq(ism.owner(), OWNER);
        assertEq(ism.mailbox(), MAILBOX);
        assertEq(ism.dailyCapWei(), DAILY_CAP);
        assertEq(ism.opTimelock(), TIMELOCK);
        assertEq(ism.dailyUsedWei(), 0);
        assertEq(ism.currentDayUtc(), 0);
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new RateLimitISM(address(0), MAILBOX, DAILY_CAP, TIMELOCK);
    }

    function test_constructor_revertsOnZeroMailbox() public {
        vm.expectRevert(RateLimitISM.RateLimitISM_ZeroAddress.selector);
        new RateLimitISM(OWNER, address(0), DAILY_CAP, TIMELOCK);
    }

    function test_constructor_revertsOnTimelockTooLow() public {
        vm.expectRevert(
            abi.encodeWithSelector(RateLimitISM.RateLimitISM_BadOpTimelock.selector, uint64(1))
        );
        new RateLimitISM(OWNER, MAILBOX, DAILY_CAP, 1);
    }

    function test_constructor_revertsOnTimelockTooHigh() public {
        vm.expectRevert(
            abi.encodeWithSelector(RateLimitISM.RateLimitISM_BadOpTimelock.selector, uint64(8 days))
        );
        new RateLimitISM(OWNER, MAILBOX, DAILY_CAP, 8 days);
    }

    function test_moduleType_returnsNull() public view {
        assertEq(ism.moduleType(), 6);
    }

    /* -------------------------------------------------------------------- */
    /*                              verify                                  */
    /* -------------------------------------------------------------------- */

    function test_verify_revertsForNonMailbox() public {
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(RateLimitISM.RateLimitISM_OnlyMailbox.selector, ATTACKER)
        );
        ism.verify("", _msg(1));
    }

    function test_verify_passes_underBudget() public {
        assertTrue(_verifyAs(MAILBOX, 10_000 ether));
        assertEq(ism.dailyUsedWei(), 10_000 ether);
    }

    function test_verify_passes_atExactBudget() public {
        assertTrue(_verifyAs(MAILBOX, DAILY_CAP));
        assertEq(ism.dailyUsedWei(), DAILY_CAP);
    }

    function test_verify_rejectsOverBudget_doesNotConsume() public {
        // Burn 49k, then attempt 2k → would reach 51k > 50k cap.
        assertTrue(_verifyAs(MAILBOX, 49_000 ether));
        assertFalse(_verifyAs(MAILBOX, 2_000 ether));
        // Used unchanged.
        assertEq(ism.dailyUsedWei(), 49_000 ether);
        // A 1k-ether attempt should still fit (49k + 1k = 50k).
        assertTrue(_verifyAs(MAILBOX, 1_000 ether));
        assertEq(ism.dailyUsedWei(), DAILY_CAP);
    }

    function test_verify_accumulates() public {
        assertTrue(_verifyAs(MAILBOX, 10_000 ether));
        assertTrue(_verifyAs(MAILBOX, 15_000 ether));
        assertTrue(_verifyAs(MAILBOX, 5_000 ether));
        assertEq(ism.dailyUsedWei(), 30_000 ether);
    }

    function test_verify_rejectsTooShortMessage() public {
        bytes memory short = new bytes(76);
        vm.prank(MAILBOX);
        bool ok = ism.verify("", short);
        assertFalse(ok);
        assertEq(ism.dailyUsedWei(), 0);
    }

    function test_verify_rejectsWrongBodyLength() public {
        bytes memory header = new bytes(77);
        bytes memory body = new bytes(64);
        vm.prank(MAILBOX);
        bool ok = ism.verify("", bytes.concat(header, body));
        assertFalse(ok);
        assertEq(ism.dailyUsedWei(), 0);
    }

    /* -------------------------------------------------------------------- */
    /*                            DAY ROLLOVER                              */
    /* -------------------------------------------------------------------- */

    function test_verify_resetsOnDayBoundary() public {
        assertTrue(_verifyAs(MAILBOX, 40_000 ether));
        uint32 day0 = ism.currentDayUtc();

        vm.warp(block.timestamp + 1 days);

        // First verify of new day rolls counter back to zero before adding.
        assertTrue(_verifyAs(MAILBOX, 40_000 ether));
        assertEq(ism.dailyUsedWei(), 40_000 ether);
        assertGt(ism.currentDayUtc(), day0);
    }

    function test_verify_overCapPersistsRollEvenOnReject() public {
        // Day 0: burn 40k.
        assertTrue(_verifyAs(MAILBOX, 40_000 ether));
        uint32 day0 = ism.currentDayUtc();

        // Day 1: attempt 60k (over the 50k cap). Counter should roll to day 1
        // and stay at zero, even though the message itself is rejected.
        vm.warp(block.timestamp + 1 days);
        assertFalse(_verifyAs(MAILBOX, 60_000 ether));
        assertGt(ism.currentDayUtc(), day0);
        assertEq(ism.dailyUsedWei(), 0);
    }

    function test_wouldFit_treatsRolloverAsClean() public {
        // Burn close to the cap on day 0.
        assertTrue(_verifyAs(MAILBOX, 49_000 ether));
        // wouldFit on day 1 should reflect a clean budget.
        vm.warp(block.timestamp + 1 days);
        assertTrue(ism.wouldFit(50_000 ether));
        // wouldFit on day 0 reflects current cumulative.
        vm.warp(block.timestamp - 1 days);
        assertFalse(ism.wouldFit(2_000 ether));
        assertTrue(ism.wouldFit(1_000 ether));
    }

    /* -------------------------------------------------------------------- */
    /*                       OWNER TIMELOCKED OPS                           */
    /* -------------------------------------------------------------------- */

    function test_setDailyCap_executesAfterTimelock() public {
        vm.prank(OWNER);
        uint256 id = ism.requestSetDailyCap(1_000_000 ether);

        // Pre-timelock: reverts.
        vm.prank(OWNER);
        vm.expectRevert();
        ism.executeOp(id);

        vm.warp(block.timestamp + TIMELOCK);
        vm.prank(OWNER);
        ism.executeOp(id);
        assertEq(ism.dailyCapWei(), 1_000_000 ether);
    }

    function test_setDailyCap_rejectsForNonOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        ism.requestSetDailyCap(1);
    }

    function test_setMailbox_executesAfterTimelock() public {
        vm.prank(OWNER);
        uint256 id = ism.requestSetMailbox(address(0xFEED));
        vm.warp(block.timestamp + TIMELOCK);
        vm.prank(OWNER);
        ism.executeOp(id);
        assertEq(ism.mailbox(), address(0xFEED));

        // Old mailbox can no longer call.
        vm.prank(MAILBOX);
        vm.expectRevert(
            abi.encodeWithSelector(RateLimitISM.RateLimitISM_OnlyMailbox.selector, MAILBOX)
        );
        ism.verify("", _msg(1));

        // New mailbox can.
        vm.prank(address(0xFEED));
        assertTrue(ism.verify("", _msg(1)));
    }

    function test_setMailbox_rejectsZero() public {
        vm.prank(OWNER);
        vm.expectRevert(RateLimitISM.RateLimitISM_ZeroAddress.selector);
        ism.requestSetMailbox(address(0));
    }

    function test_executeOp_revertsOnInvalidId() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(RateLimitISM.RateLimitISM_InvalidOpId.selector, uint256(42))
        );
        ism.executeOp(42);
    }

    function test_executeOp_revertsOnDoubleExecute() public {
        _wireDailyCap(123);
        // re-executing id=1 should now revert.
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(RateLimitISM.RateLimitISM_OpAlreadyExecuted.selector, uint256(1))
        );
        ism.executeOp(1);
    }

    function test_cancelOp_blocksExecute() public {
        vm.prank(OWNER);
        uint256 id = ism.requestSetDailyCap(999);
        vm.prank(OWNER);
        ism.cancelOp(id);

        vm.warp(block.timestamp + TIMELOCK);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(RateLimitISM.RateLimitISM_OpAlreadyCancelled.selector, id)
        );
        ism.executeOp(id);
        assertEq(ism.dailyCapWei(), DAILY_CAP);
    }

    function test_cancelOp_revertsOnDoubleCancel() public {
        vm.prank(OWNER);
        uint256 id = ism.requestSetDailyCap(999);
        vm.prank(OWNER);
        ism.cancelOp(id);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(RateLimitISM.RateLimitISM_OpAlreadyCancelled.selector, id)
        );
        ism.cancelOp(id);
    }

    /* -------------------------------------------------------------------- */
    /*                          POST-CAP-CHANGE                             */
    /* -------------------------------------------------------------------- */

    function test_capRaise_unblocksMessage() public {
        // Saturate the day at 50k.
        assertTrue(_verifyAs(MAILBOX, DAILY_CAP));
        // 1 wei more rejects.
        assertFalse(_verifyAs(MAILBOX, 1));

        _wireDailyCap(100_000 ether);
        // Note: _wireDailyCap warps forward by 24h, which crosses a UTC day.
        // Counter therefore resets, and new cap accepts a 100k message.
        assertTrue(_verifyAs(MAILBOX, 100_000 ether));
    }

    function test_capLower_doesNotRetroactivelyReject() public {
        assertTrue(_verifyAs(MAILBOX, 30_000 ether));
        // Lower the cap to 20k. This warps 24h, so dailyUsed resets to 0
        // before the 30k accumulation; subsequent verify against the new
        // 20k cap reflects only post-change usage, not prior burn.
        _wireDailyCap(20_000 ether);
        assertTrue(_verifyAs(MAILBOX, 15_000 ether));
        assertFalse(_verifyAs(MAILBOX, 6_000 ether));
    }
}
