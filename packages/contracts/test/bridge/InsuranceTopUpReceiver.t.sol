// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {InsuranceTopUpReceiver} from "../../src/bridge/InsuranceTopUpReceiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract InsuranceTopUpReceiverTest is Test {
    InsuranceTopUpReceiver internal receiver;

    address internal constant OWNER = address(0x0117E2);
    address internal constant MAILBOX = address(0xFA7B);
    address internal constant ATTACKER = address(0xBAD);

    uint32 internal constant ETH_DOMAIN = 1;
    uint32 internal constant BNB_DOMAIN = 56;

    bytes32 internal constant ETH_MINTER = bytes32(uint256(uint160(0xABCD1234)));
    bytes32 internal constant BNB_MINTER = bytes32(uint256(uint160(0xABCD5678)));

    uint64 internal constant OP_TIMELOCK = 24 hours;

    function setUp() public {
        receiver = new InsuranceTopUpReceiver(OWNER, MAILBOX, OP_TIMELOCK);
    }

    /* ----------------------------- helpers ------------------------------ */

    function _wireTrusted(uint32 origin, bytes32 trusted) internal {
        vm.prank(OWNER);
        uint256 id = receiver.requestSetTrustedSender(origin, trusted);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        receiver.executeOp(id);
    }

    function _body(bytes32 noticeId, uint32 srcDomain, uint128 amountWei, uint64 ts)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(noticeId, srcDomain, amountWei, ts);
    }

    function _deliver(uint32 origin, bytes32 sender, bytes memory body) internal {
        vm.prank(MAILBOX);
        receiver.handle(origin, sender, body);
    }

    /* -------------------------------------------------------------------- */
    /*                            CONSTRUCTOR                               */
    /* -------------------------------------------------------------------- */

    function test_constructor_setsImmutables() public view {
        assertEq(receiver.hyperlaneMailbox(), MAILBOX);
        assertEq(uint256(receiver.opTimelock()), uint256(OP_TIMELOCK));
        assertEq(receiver.owner(), OWNER);
    }

    function test_constructor_zeroOwnerReverts() public {
        vm.expectRevert();
        new InsuranceTopUpReceiver(address(0), MAILBOX, OP_TIMELOCK);
    }

    function test_constructor_zeroMailboxReverts() public {
        vm.expectRevert(InsuranceTopUpReceiver.TopUpReceiver_ZeroAddress.selector);
        new InsuranceTopUpReceiver(OWNER, address(0), OP_TIMELOCK);
    }

    function test_constructor_timelockOutOfRangeReverts() public {
        vm.expectRevert();
        new InsuranceTopUpReceiver(OWNER, MAILBOX, 30 minutes);
        vm.expectRevert();
        new InsuranceTopUpReceiver(OWNER, MAILBOX, 60 days);
    }

    /* -------------------------------------------------------------------- */
    /*                          INBOUND HANDLE                              */
    /* -------------------------------------------------------------------- */

    function test_handle_recordsNotice() public {
        _wireTrusted(ETH_DOMAIN, ETH_MINTER);

        bytes32 noticeId = keccak256("notice-1");
        uint128 amount = 1 ether;
        uint64 srcTs = uint64(block.timestamp);

        _deliver(ETH_DOMAIN, ETH_MINTER, _body(noticeId, ETH_DOMAIN, amount, srcTs));

        (
            uint128 amt,
            uint32 origin,
            uint64 receivedAt,
            uint64 settledAt,
            uint128 settledEtx,
            address settledBy,
            bool settled
        ) = receiver.notices(noticeId);
        assertEq(uint256(amt), uint256(amount));
        assertEq(uint256(origin), uint256(ETH_DOMAIN));
        assertEq(uint256(receivedAt), uint256(uint64(block.timestamp)));
        assertEq(uint256(settledAt), 0);
        assertEq(uint256(settledEtx), 0);
        assertEq(settledBy, address(0));
        assertFalse(settled);

        assertEq(uint256(receiver.lifetimeNativeReceived(ETH_DOMAIN)), uint256(amount));
        assertEq(uint256(receiver.lifetimeNativeSettled(ETH_DOMAIN)), 0);
        assertEq(uint256(receiver.pendingNativePerOrigin(ETH_DOMAIN)), uint256(amount));
    }

    function test_handle_onlyMailbox() public {
        _wireTrusted(ETH_DOMAIN, ETH_MINTER);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(
                InsuranceTopUpReceiver.TopUpReceiver_OnlyMailbox.selector, ATTACKER
            )
        );
        receiver.handle(ETH_DOMAIN, ETH_MINTER, _body(bytes32(0), ETH_DOMAIN, 1 ether, 0));
    }

    function test_handle_untrustedOriginReverts() public {
        // No trusted sender wired for ETH_DOMAIN yet.
        vm.prank(MAILBOX);
        vm.expectRevert(
            abi.encodeWithSelector(
                InsuranceTopUpReceiver.TopUpReceiver_UntrustedOrigin.selector, ETH_DOMAIN
            )
        );
        receiver.handle(ETH_DOMAIN, ETH_MINTER, _body(bytes32(uint256(1)), ETH_DOMAIN, 1 ether, 0));
    }

    function test_handle_untrustedSenderReverts() public {
        _wireTrusted(ETH_DOMAIN, ETH_MINTER);
        bytes32 wrong = bytes32(uint256(0xDEAD));
        vm.prank(MAILBOX);
        vm.expectRevert(
            abi.encodeWithSelector(
                InsuranceTopUpReceiver.TopUpReceiver_UntrustedSender.selector, wrong
            )
        );
        receiver.handle(ETH_DOMAIN, wrong, _body(bytes32(uint256(1)), ETH_DOMAIN, 1 ether, 0));
    }

    function test_handle_malformedBodyReverts() public {
        _wireTrusted(ETH_DOMAIN, ETH_MINTER);
        vm.prank(MAILBOX);
        vm.expectRevert(InsuranceTopUpReceiver.TopUpReceiver_MalformedBody.selector);
        receiver.handle(ETH_DOMAIN, ETH_MINTER, hex"deadbeef");
    }

    function test_handle_srcDomainMismatchReverts() public {
        _wireTrusted(ETH_DOMAIN, ETH_MINTER);
        // body claims srcDomain = BNB_DOMAIN but origin is ETH_DOMAIN.
        bytes memory body = _body(bytes32(uint256(1)), BNB_DOMAIN, 1 ether, 0);
        vm.prank(MAILBOX);
        vm.expectRevert(
            abi.encodeWithSelector(
                InsuranceTopUpReceiver.TopUpReceiver_UntrustedOrigin.selector, BNB_DOMAIN
            )
        );
        receiver.handle(ETH_DOMAIN, ETH_MINTER, body);
    }

    function test_handle_zeroAmountReverts() public {
        _wireTrusted(ETH_DOMAIN, ETH_MINTER);
        vm.prank(MAILBOX);
        vm.expectRevert(InsuranceTopUpReceiver.TopUpReceiver_ZeroAmount.selector);
        receiver.handle(ETH_DOMAIN, ETH_MINTER, _body(bytes32(uint256(1)), ETH_DOMAIN, 0, 0));
    }

    function test_handle_replayReverts() public {
        _wireTrusted(ETH_DOMAIN, ETH_MINTER);
        bytes32 noticeId = keccak256("dup");
        bytes memory body = _body(noticeId, ETH_DOMAIN, 1 ether, 0);
        _deliver(ETH_DOMAIN, ETH_MINTER, body);

        vm.prank(MAILBOX);
        vm.expectRevert(
            abi.encodeWithSelector(
                InsuranceTopUpReceiver.TopUpReceiver_NoticeAlreadyReceived.selector, noticeId
            )
        );
        receiver.handle(ETH_DOMAIN, ETH_MINTER, body);
    }

    function test_handle_multipleOriginsAccumulate() public {
        _wireTrusted(ETH_DOMAIN, ETH_MINTER);
        _wireTrusted(BNB_DOMAIN, BNB_MINTER);

        _deliver(ETH_DOMAIN, ETH_MINTER, _body(keccak256("a"), ETH_DOMAIN, 1 ether, 0));
        _deliver(ETH_DOMAIN, ETH_MINTER, _body(keccak256("b"), ETH_DOMAIN, 2 ether, 0));
        _deliver(BNB_DOMAIN, BNB_MINTER, _body(keccak256("c"), BNB_DOMAIN, 3 ether, 0));

        assertEq(uint256(receiver.lifetimeNativeReceived(ETH_DOMAIN)), uint256(3 ether));
        assertEq(uint256(receiver.lifetimeNativeReceived(BNB_DOMAIN)), uint256(3 ether));
        assertEq(uint256(receiver.pendingNativePerOrigin(ETH_DOMAIN)), uint256(3 ether));
        assertEq(uint256(receiver.pendingNativePerOrigin(BNB_DOMAIN)), uint256(3 ether));
    }

    /* -------------------------------------------------------------------- */
    /*                            SETTLEMENT                                */
    /* -------------------------------------------------------------------- */

    function test_markSettled_updatesNoticeAndCounters() public {
        _wireTrusted(ETH_DOMAIN, ETH_MINTER);
        bytes32 noticeId = keccak256("s1");
        _deliver(ETH_DOMAIN, ETH_MINTER, _body(noticeId, ETH_DOMAIN, 1 ether, 0));

        uint128 etxAmount = uint128(2_500 ether);
        vm.prank(OWNER);
        receiver.markSettled(noticeId, etxAmount);

        (,,, uint64 settledAt, uint128 settledEtx, address settledBy, bool settled) =
            receiver.notices(noticeId);
        assertTrue(settled);
        assertEq(uint256(settledAt), uint256(uint64(block.timestamp)));
        assertEq(uint256(settledEtx), uint256(etxAmount));
        assertEq(settledBy, OWNER);
        assertEq(uint256(receiver.lifetimeNativeSettled(ETH_DOMAIN)), uint256(1 ether));
        assertEq(uint256(receiver.pendingNativePerOrigin(ETH_DOMAIN)), 0);
    }

    function test_markSettled_onlyOwner() public {
        _wireTrusted(ETH_DOMAIN, ETH_MINTER);
        bytes32 noticeId = keccak256("s2");
        _deliver(ETH_DOMAIN, ETH_MINTER, _body(noticeId, ETH_DOMAIN, 1 ether, 0));

        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        receiver.markSettled(noticeId, 1 ether);
    }

    function test_markSettled_unknownReverts() public {
        bytes32 noticeId = keccak256("ghost");
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                InsuranceTopUpReceiver.TopUpReceiver_UnknownNotice.selector, noticeId
            )
        );
        receiver.markSettled(noticeId, 1 ether);
    }

    function test_markSettled_doubleReverts() public {
        _wireTrusted(ETH_DOMAIN, ETH_MINTER);
        bytes32 noticeId = keccak256("s3");
        _deliver(ETH_DOMAIN, ETH_MINTER, _body(noticeId, ETH_DOMAIN, 1 ether, 0));
        vm.prank(OWNER);
        receiver.markSettled(noticeId, 1 ether);

        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                InsuranceTopUpReceiver.TopUpReceiver_AlreadySettled.selector, noticeId
            )
        );
        receiver.markSettled(noticeId, 1 ether);
    }

    function test_markSettled_zeroAmountReverts() public {
        _wireTrusted(ETH_DOMAIN, ETH_MINTER);
        bytes32 noticeId = keccak256("s4");
        _deliver(ETH_DOMAIN, ETH_MINTER, _body(noticeId, ETH_DOMAIN, 1 ether, 0));
        vm.prank(OWNER);
        vm.expectRevert(InsuranceTopUpReceiver.TopUpReceiver_ZeroAmount.selector);
        receiver.markSettled(noticeId, 0);
    }

    /* -------------------------------------------------------------------- */
    /*                         OWNER TIMELOCK OPS                           */
    /* -------------------------------------------------------------------- */

    function test_setTrustedSender_timelockedAndStores() public {
        vm.prank(OWNER);
        uint256 id = receiver.requestSetTrustedSender(ETH_DOMAIN, ETH_MINTER);

        // Premature execute reverts.
        vm.prank(OWNER);
        vm.expectRevert();
        receiver.executeOp(id);

        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        receiver.executeOp(id);
        assertEq(receiver.trustedSender(ETH_DOMAIN), ETH_MINTER);
    }

    function test_setTrustedSender_onlyOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        receiver.requestSetTrustedSender(ETH_DOMAIN, ETH_MINTER);
    }

    function test_cancelOp_blocksExecute() public {
        vm.prank(OWNER);
        uint256 id = receiver.requestSetTrustedSender(ETH_DOMAIN, ETH_MINTER);
        vm.prank(OWNER);
        receiver.cancelOp(id);

        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                InsuranceTopUpReceiver.TopUpReceiver_OpAlreadyCancelled.selector, id
            )
        );
        receiver.executeOp(id);
    }

    function test_cancelOp_onlyOwner() public {
        vm.prank(OWNER);
        uint256 id = receiver.requestSetTrustedSender(ETH_DOMAIN, ETH_MINTER);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        receiver.cancelOp(id);
    }

    function test_executeOp_doubleReverts() public {
        vm.prank(OWNER);
        uint256 id = receiver.requestSetTrustedSender(ETH_DOMAIN, ETH_MINTER);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        receiver.executeOp(id);

        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                InsuranceTopUpReceiver.TopUpReceiver_OpAlreadyExecuted.selector, id
            )
        );
        receiver.executeOp(id);
    }

    function test_executeOp_invalidIdReverts() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                InsuranceTopUpReceiver.TopUpReceiver_InvalidOpId.selector, uint256(99)
            )
        );
        receiver.executeOp(99);
    }

    function test_executeOp_clearAndRewireTrustedSender() public {
        _wireTrusted(ETH_DOMAIN, ETH_MINTER);
        // Rotate to a different trusted minter (e.g. after a redeploy).
        bytes32 newMinter = bytes32(uint256(uint160(0x9999)));
        _wireTrusted(ETH_DOMAIN, newMinter);
        assertEq(receiver.trustedSender(ETH_DOMAIN), newMinter);
    }
}
