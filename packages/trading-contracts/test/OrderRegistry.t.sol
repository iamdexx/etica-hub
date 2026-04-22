// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import {Test, Vm} from "forge-std/Test.sol";
import {OrderRegistry} from "../src/OrderRegistry.sol";

contract OrderRegistryTest is Test {
    OrderRegistry registry;

    address constant ALICE = address(0xA1);
    address constant BOB = address(0xB0);

    function setUp() public {
        registry = new OrderRegistry();
    }

    // ---------- helpers ----------

    function _limitMeta() internal pure returns (OrderRegistry.OrderMeta memory) {
        return OrderRegistry.OrderMeta({
            strategy: OrderRegistry.Strategy.LIMIT,
            triggerDirection: 0,
            indexInBatch: 0,
            totalInBatch: 0,
            batchId: bytes32(0),
            triggerPrice: 0,
            levelPrice: 0
        });
    }

    function _stopMeta(uint256 trigger, uint8 dir) internal pure returns (OrderRegistry.OrderMeta memory) {
        return OrderRegistry.OrderMeta({
            strategy: OrderRegistry.Strategy.STOP,
            triggerDirection: dir,
            indexInBatch: 0,
            totalInBatch: 0,
            batchId: bytes32(0),
            triggerPrice: trigger,
            levelPrice: 0
        });
    }

    function _gridMeta(bytes32 batchId, uint16 idx, uint16 total, uint256 levelPrice)
        internal
        pure
        returns (OrderRegistry.OrderMeta memory)
    {
        return OrderRegistry.OrderMeta({
            strategy: OrderRegistry.Strategy.GRID,
            triggerDirection: 0,
            indexInBatch: idx,
            totalInBatch: total,
            batchId: batchId,
            triggerPrice: 0,
            levelPrice: levelPrice
        });
    }

    // ---------- postOrder ----------

    function test_postOrder_storesAndEmits() public {
        bytes memory encoded = hex"deadbeef";
        bytes memory sig = hex"c0ffee";
        OrderRegistry.OrderMeta memory meta = _limitMeta();
        bytes32 expectedHash = keccak256(encoded);

        vm.prank(ALICE);
        vm.recordLogs();
        bytes32 hash = registry.postOrder(encoded, sig, meta);
        assertEq(hash, expectedHash, "returned hash mismatch");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "should emit exactly one log");
        assertEq(
            logs[0].topics[0],
            keccak256(
                "OrderPosted(bytes32,address,uint8,bytes,bytes,(uint8,uint8,uint16,uint16,bytes32,uint256,uint256))"
            )
        );
        assertEq(logs[0].topics[1], expectedHash, "topic[1] = orderHash");
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(ALICE))), "topic[2] = poster");
        assertEq(logs[0].topics[3], bytes32(uint256(uint8(OrderRegistry.Strategy.LIMIT))), "topic[3] = strategy");

        OrderRegistry.StoredOrder memory stored = registry.getOrder(hash);
        assertEq(stored.encodedOrder, encoded);
        assertEq(stored.signature, sig);
        assertEq(stored.poster, ALICE);
        assertEq(stored.cancelled, false);
        assertGt(stored.postedAt, 0);
    }

    function test_postOrder_rejectsEmptyEncoded() public {
        vm.expectRevert(OrderRegistry.EmptyOrder.selector);
        vm.prank(ALICE);
        registry.postOrder("", hex"c0ffee", _limitMeta());
    }

    function test_postOrder_rejectsEmptySignature() public {
        vm.expectRevert(OrderRegistry.EmptySignature.selector);
        vm.prank(ALICE);
        registry.postOrder(hex"deadbeef", "", _limitMeta());
    }

    function test_postOrder_rejectsDuplicate() public {
        bytes memory encoded = hex"deadbeef";
        vm.prank(ALICE);
        registry.postOrder(encoded, hex"c0ffee", _limitMeta());

        vm.expectRevert(OrderRegistry.OrderAlreadyPosted.selector);
        vm.prank(BOB);
        registry.postOrder(encoded, hex"c0ffee", _limitMeta());
    }

    function test_postOrder_stopFlavorRoundtrips() public {
        OrderRegistry.OrderMeta memory meta = _stopMeta(1234e18, 1);
        vm.prank(ALICE);
        bytes32 hash = registry.postOrder(hex"aa", hex"bb", meta);
        assertTrue(registry.exists(hash));
    }

    // ---------- postOrderBatch ----------

    function test_postOrderBatch_storesAllLegs() public {
        bytes[] memory encodeds = new bytes[](3);
        bytes[] memory sigs = new bytes[](3);
        OrderRegistry.OrderMeta[] memory metas = new OrderRegistry.OrderMeta[](3);
        bytes32 batchId = keccak256("batch-1");
        for (uint256 i = 0; i < 3; i++) {
            encodeds[i] = abi.encodePacked(hex"aa", bytes1(uint8(i)));
            sigs[i] = abi.encodePacked(hex"bb", bytes1(uint8(i)));
            metas[i] = _gridMeta(batchId, uint16(i), 3, (i + 1) * 1e18);
        }

        vm.prank(ALICE);
        bytes32[] memory hashes = registry.postOrderBatch(encodeds, sigs, metas);
        assertEq(hashes.length, 3);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(hashes[i], keccak256(encodeds[i]));
            assertTrue(registry.exists(hashes[i]));
        }
    }

    function test_postOrderBatch_rejectsLengthMismatch() public {
        bytes[] memory encodeds = new bytes[](2);
        bytes[] memory sigs = new bytes[](3);
        OrderRegistry.OrderMeta[] memory metas = new OrderRegistry.OrderMeta[](2);
        encodeds[0] = hex"aa";
        encodeds[1] = hex"bb";
        sigs[0] = hex"11";
        sigs[1] = hex"22";
        sigs[2] = hex"33";
        metas[0] = _limitMeta();
        metas[1] = _limitMeta();

        vm.expectRevert(OrderRegistry.BatchLengthMismatch.selector);
        vm.prank(ALICE);
        registry.postOrderBatch(encodeds, sigs, metas);
    }

    function test_postOrderBatch_rejectsEmpty() public {
        bytes[] memory encodeds = new bytes[](0);
        bytes[] memory sigs = new bytes[](0);
        OrderRegistry.OrderMeta[] memory metas = new OrderRegistry.OrderMeta[](0);

        vm.expectRevert(OrderRegistry.EmptyBatch.selector);
        vm.prank(ALICE);
        registry.postOrderBatch(encodeds, sigs, metas);
    }

    function test_postOrderBatch_rejectsOversizedBatch() public {
        uint256 oversized = registry.MAX_BATCH_SIZE() + 1;
        bytes[] memory encodeds = new bytes[](oversized);
        bytes[] memory sigs = new bytes[](oversized);
        OrderRegistry.OrderMeta[] memory metas = new OrderRegistry.OrderMeta[](oversized);
        for (uint256 i = 0; i < oversized; i++) {
            encodeds[i] = abi.encodePacked(bytes32(uint256(i + 1)));
            sigs[i] = abi.encodePacked(bytes32(uint256(i + 1)));
            metas[i] = _limitMeta();
        }

        vm.expectRevert(OrderRegistry.BatchTooLarge.selector);
        vm.prank(ALICE);
        registry.postOrderBatch(encodeds, sigs, metas);
    }

    function test_postOrderBatch_acceptsMaxSizeBatch() public {
        uint256 n = registry.MAX_BATCH_SIZE();
        bytes[] memory encodeds = new bytes[](n);
        bytes[] memory sigs = new bytes[](n);
        OrderRegistry.OrderMeta[] memory metas = new OrderRegistry.OrderMeta[](n);
        for (uint256 i = 0; i < n; i++) {
            encodeds[i] = abi.encodePacked(bytes32(uint256(i + 1)));
            sigs[i] = abi.encodePacked(bytes32(uint256(i + 1)));
            metas[i] = _limitMeta();
        }

        vm.prank(ALICE);
        bytes32[] memory hashes = registry.postOrderBatch(encodeds, sigs, metas);
        assertEq(hashes.length, n);
    }

    function test_postOrderBatch_rejectsDuplicateAcrossBatch() public {
        bytes[] memory encodeds = new bytes[](2);
        bytes[] memory sigs = new bytes[](2);
        OrderRegistry.OrderMeta[] memory metas = new OrderRegistry.OrderMeta[](2);
        encodeds[0] = hex"aa";
        encodeds[1] = hex"aa"; // same raw bytes => same hash
        sigs[0] = hex"11";
        sigs[1] = hex"22";
        metas[0] = _limitMeta();
        metas[1] = _limitMeta();

        vm.expectRevert(OrderRegistry.OrderAlreadyPosted.selector);
        vm.prank(ALICE);
        registry.postOrderBatch(encodeds, sigs, metas);
    }

    // ---------- cancelOrder ----------

    function test_cancelOrder_byPosterFlips() public {
        vm.prank(ALICE);
        bytes32 hash = registry.postOrder(hex"aa", hex"bb", _limitMeta());
        assertFalse(registry.isCancelled(hash));

        vm.prank(ALICE);
        registry.cancelOrder(hash);
        assertTrue(registry.isCancelled(hash));
    }

    function test_cancelOrder_emitsEvent() public {
        vm.prank(ALICE);
        bytes32 hash = registry.postOrder(hex"aa", hex"bb", _limitMeta());

        vm.expectEmit(true, true, false, false);
        emit OrderRegistry.OrderCancelled(hash, ALICE);
        vm.prank(ALICE);
        registry.cancelOrder(hash);
    }

    function test_cancelOrder_rejectsNonPoster() public {
        vm.prank(ALICE);
        bytes32 hash = registry.postOrder(hex"aa", hex"bb", _limitMeta());

        vm.expectRevert(OrderRegistry.NotPoster.selector);
        vm.prank(BOB);
        registry.cancelOrder(hash);
    }

    function test_cancelOrder_rejectsUnknownHash() public {
        vm.expectRevert(OrderRegistry.OrderNotFound.selector);
        vm.prank(ALICE);
        registry.cancelOrder(keccak256("does-not-exist"));
    }

    function test_cancelOrder_isIdempotentButReemits() public {
        vm.prank(ALICE);
        bytes32 hash = registry.postOrder(hex"aa", hex"bb", _limitMeta());

        vm.prank(ALICE);
        registry.cancelOrder(hash);
        assertTrue(registry.isCancelled(hash));

        // second cancel still succeeds and keeps flag set (simple + gas-cheap)
        vm.prank(ALICE);
        registry.cancelOrder(hash);
        assertTrue(registry.isCancelled(hash));
    }

    // ---------- view helpers ----------

    function test_getOrder_revertsForUnknown() public {
        vm.expectRevert(OrderRegistry.OrderNotFound.selector);
        registry.getOrder(keccak256("nope"));
    }

    function test_exists_falseForUnknown() public view {
        assertFalse(registry.exists(keccak256("nope")));
    }

    function test_isCancelled_falseForUnknown() public view {
        assertFalse(registry.isCancelled(keccak256("nope")));
    }
}
