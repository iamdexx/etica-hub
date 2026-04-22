// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

/// @title  OrderRegistry
/// @notice Permissionless on-chain registry for signed UniswapX orders.
///
///         Swappers call {postOrder} (or {postOrderBatch}) to publish signed
///         DutchOrders on-chain. Keepers discover work by subscribing to
///         {OrderPosted} logs and submit fills via the reactor in the normal
///         UniswapX flow; the registry never touches funds and never talks to
///         Permit2 or the reactor.
///
///         The registry is **fully permissionless**: there is no owner, no
///         pausing, no censorship surface. Anyone can post anything (they pay
///         gas). Orders with invalid signatures will simply fail at the
///         reactor when a keeper tries to fill them and are effectively
///         filtered out by the keeper's simulation step. Registry-level
///         cancellation is a convenience signal for keepers to skip an order;
///         the authoritative cancellation is still on-chain nonce
///         invalidation via Permit2 (or the order's deadline lapsing).
///
///         Designed to be trivially upgradeable by redeploying — keepers
///         discover the active registry from `DEPLOYMENTS.orderRegistry` in
///         the frontend, so migration is a single address change.
contract OrderRegistry {
    /// @notice Strategy flavor tag, matched to the off-chain orderbook's
    ///         `strategyType` enum. Keepers read this to decide whether
    ///         extra trigger gating applies (e.g. stop orders sleep until
    ///         their trigger fires).
    enum Strategy {
        LIMIT,
        STOP,
        DCA,
        GRID
    }

    /// @notice Per-order metadata. Packs tightly: one 32-byte slot for the
    ///         scalar fields + two dynamic 32-byte slots for prices + one
    ///         slot for the batch id. Fields that don't apply to the current
    ///         strategy (e.g. `triggerPrice` on a limit order) must be zero.
    struct OrderMeta {
        Strategy strategy;
        /// @dev 0 = lte (stop-loss fires when price ≤ trigger), 1 = gte. Only meaningful for STOP.
        uint8 triggerDirection;
        /// @dev 0-based position within a DCA / GRID batch. Zero for LIMIT / STOP.
        uint16 indexInBatch;
        /// @dev Total legs / levels in the batch. Zero for LIMIT / STOP.
        uint16 totalInBatch;
        /// @dev Shared identifier across every leg of a DCA / GRID batch. Zero for LIMIT / STOP.
        bytes32 batchId;
        /// @dev ETX-per-base * 1e18, only set for STOP.
        uint256 triggerPrice;
        /// @dev ETX-per-base * 1e18 for this specific GRID level. Zero for LIMIT / STOP / DCA.
        uint256 levelPrice;
    }

    /// @notice Stored order record. Indexed by the keccak256 of the raw
    ///         encoded order (which is stable for a given DutchOrder because
    ///         the reactor hashes the same bytes during execution).
    struct StoredOrder {
        bytes encodedOrder;
        bytes signature;
        /// @dev Address that called {postOrder}. Only this address can mark
        ///      the order cancelled at the registry layer. Typically the
        ///      swapper themselves, but relayers are possible.
        address poster;
        /// @dev Timestamp the order was posted at. Useful for ordering in
        ///      keeper indexes.
        uint64 postedAt;
        /// @dev Set when the poster explicitly cancels via {cancelOrder}.
        bool cancelled;
    }

    /// @notice Canonical `keccak256(encodedOrder)` → stored order.
    mapping(bytes32 => StoredOrder) private _orders;

    /// @notice Emitted once per newly-posted order. Keepers subscribe to
    ///         this event to discover fresh work. The full encodedOrder +
    ///         signature are emitted in-band so an indexer-less keeper can
    ///         reconstruct everything it needs from the log.
    event OrderPosted(
        bytes32 indexed orderHash,
        address indexed poster,
        Strategy indexed strategy,
        bytes encodedOrder,
        bytes signature,
        OrderMeta meta
    );

    /// @notice Emitted when the original poster flags an order as cancelled.
    event OrderCancelled(bytes32 indexed orderHash, address indexed poster);

    error OrderAlreadyPosted();
    error OrderNotFound();
    error NotPoster();
    error EmptyOrder();
    error EmptySignature();
    error BatchLengthMismatch();
    error EmptyBatch();
    error BatchTooLarge();

    /// @notice Hard cap on orders per {postOrderBatch} call. Chosen to comfortably
    ///         cover the Infinity / Grid bot's {MAX_LEVELS} (50) with headroom,
    ///         while keeping the per-call log footprint bounded so indexers
    ///         don't have to handle pathological single-tx log bursts.
    uint256 public constant MAX_BATCH_SIZE = 64;

    /// @notice Post a single signed order.
    /// @param encodedOrder The abi-encoded UniswapX DutchOrder bytes.
    /// @param signature The EIP-712 signature over the order's Permit2 witness.
    /// @param meta Strategy flavor + optional trigger / batch metadata.
    /// @return orderHash Canonical `keccak256(encodedOrder)` identifier.
    function postOrder(bytes calldata encodedOrder, bytes calldata signature, OrderMeta calldata meta)
        external
        returns (bytes32 orderHash)
    {
        orderHash = _post(encodedOrder, signature, meta);
    }

    /// @notice Post a batch of signed orders in a single transaction. Each
    ///         order is independent — ordering within the batch only affects
    ///         gas layout, not execution semantics. Useful for DCA / grid
    ///         strategies that pre-sign N orders and want to publish them
    ///         atomically.
    /// @return orderHashes Canonical hashes for each posted order, in input order.
    function postOrderBatch(bytes[] calldata encodedOrders, bytes[] calldata signatures, OrderMeta[] calldata metas)
        external
        returns (bytes32[] memory orderHashes)
    {
        uint256 n = encodedOrders.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH_SIZE) revert BatchTooLarge();
        if (signatures.length != n || metas.length != n) revert BatchLengthMismatch();
        orderHashes = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            orderHashes[i] = _post(encodedOrders[i], signatures[i], metas[i]);
        }
    }

    /// @notice Flag an order as cancelled at the registry layer.
    /// @dev Only callable by the original poster. Does NOT invalidate the
    ///      order on-chain (Permit2 still accepts the signature); keepers
    ///      honour this flag by refusing to submit, but anyone can still
    ///      call the reactor directly if they ignore the registry. For
    ///      authoritative cancellation, call Permit2's `invalidateNonces`.
    function cancelOrder(bytes32 orderHash) external {
        StoredOrder storage o = _orders[orderHash];
        if (o.poster == address(0)) revert OrderNotFound();
        if (o.poster != msg.sender) revert NotPoster();
        o.cancelled = true;
        emit OrderCancelled(orderHash, msg.sender);
    }

    /// @notice Read a stored order. Reverts with {OrderNotFound} if never posted.
    function getOrder(bytes32 orderHash) external view returns (StoredOrder memory) {
        StoredOrder memory o = _orders[orderHash];
        if (o.poster == address(0)) revert OrderNotFound();
        return o;
    }

    /// @notice Whether a given order has been posted (regardless of cancellation state).
    function exists(bytes32 orderHash) external view returns (bool) {
        return _orders[orderHash].poster != address(0);
    }

    /// @notice Whether a given order is cancelled. Returns false for unknown / never-posted hashes.
    function isCancelled(bytes32 orderHash) external view returns (bool) {
        return _orders[orderHash].cancelled;
    }

    function _post(bytes calldata encodedOrder, bytes calldata signature, OrderMeta calldata meta)
        private
        returns (bytes32 orderHash)
    {
        if (encodedOrder.length == 0) revert EmptyOrder();
        if (signature.length == 0) revert EmptySignature();
        orderHash = keccak256(encodedOrder);
        StoredOrder storage slot = _orders[orderHash];
        if (slot.poster != address(0)) revert OrderAlreadyPosted();
        slot.encodedOrder = encodedOrder;
        slot.signature = signature;
        slot.poster = msg.sender;
        slot.postedAt = uint64(block.timestamp);
        emit OrderPosted(orderHash, msg.sender, meta.strategy, encodedOrder, signature, meta);
    }
}
