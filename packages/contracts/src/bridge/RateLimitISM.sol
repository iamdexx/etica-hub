// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {BridgeMessage} from "./IBridgeMinter.sol";
import {IInterchainSecurityModule} from "./IInterchainSecurityModule.sol";

/// @title RateLimitISM
/// @notice Defense-in-depth ISM that caps the cumulative inbound mint
/// volume per UTC day. Rolls automatically at midnight UTC. Returns `false`
/// (no revert in `verify` for the over-cap path) so the mailbox keeps the
/// message pending — re-deliverable on the next day or after the operator
/// raises the cap.
///
/// Trust model:
/// - Only `mailbox` may call `verify` (state-mutating). An open `verify`
///   would let any caller burn down today's budget on a replayed message
///   and DoS the bridge until midnight UTC.
/// - The owner can change `dailyCapWei` behind a 24h timelock (per spec
///   §5.2) and rotate the trusted mailbox the same way.
///
/// State semantics:
/// - `currentDayUtc = block.timestamp / 1 days` (UTC midnight rollover).
/// - On the first verify of a new day, `dailyUsedWei` is reset to zero
///   before the new amount is added.
/// - Atomicity guarantee: Hyperlane's `process` reverts the entire tx on
///   handler failure, so an accumulated-but-then-rejected delivery does
///   not durably consume the daily budget.
contract RateLimitISM is IInterchainSecurityModule, Ownable2Step {
    /* -------------------------------------------------------------------- */
    /*                              IMMUTABLES                              */
    /* -------------------------------------------------------------------- */

    /// @notice Minimum and maximum allowed value for `opTimelock` to bound
    ///         the operator's flexibility without leaving zero-delay or
    ///         pathological multi-year delays on the table.
    uint64 public constant MIN_OP_TIMELOCK = 1 hours;
    uint64 public constant MAX_OP_TIMELOCK = 7 days;

    uint64 public immutable opTimelock;

    /* -------------------------------------------------------------------- */
    /*                                STATE                                 */
    /* -------------------------------------------------------------------- */

    /// @notice The Hyperlane mailbox authorised to call `verify`. Stored as
    /// non-immutable so it can be rotated via timelocked op (e.g. mailbox
    /// migration).
    address public mailbox;

    /// @notice Hard cap on cumulative inbound mint amount per UTC day,
    /// denominated in wETX wei. Owner-tunable via timelocked op. Set to
    /// `type(uint128).max` to effectively disable the cap.
    uint128 public dailyCapWei;

    /// @notice Cumulative wETX amount delivered through this ISM during
    /// `currentDayUtc`. Reset to zero on the first verify of each new day.
    uint128 public dailyUsedWei;

    /// @notice The UTC day index (`block.timestamp / 1 days`) `dailyUsedWei`
    /// is associated with. Updated lazily on the first verify of a new day.
    uint32 public currentDayUtc;

    /* -------------------------------------------------------------------- */
    /*                          OWNER TIMELOCK                              */
    /* -------------------------------------------------------------------- */

    enum OpKind {
        NONE,
        SET_DAILY_CAP,
        SET_MAILBOX
    }

    struct PendingOp {
        OpKind kind;
        uint64 executableAt;
        bool executed;
        bool cancelled;
        bytes payload;
    }

    uint256 public opCounter;
    mapping(uint256 id => PendingOp) public pendingOps;

    /* -------------------------------------------------------------------- */
    /*                                EVENTS                                */
    /* -------------------------------------------------------------------- */

    event MailboxRotated(address indexed oldMailbox, address indexed newMailbox);
    event DailyCapChanged(uint128 indexed oldCap, uint128 indexed newCap);
    event Verified(uint128 amount, uint128 dailyUsedAfter, uint32 dayUtc);
    event RejectedOverCap(uint128 amount, uint128 dailyUsedBefore, uint128 dailyCap, uint32 dayUtc);

    event OpRequested(uint256 indexed id, OpKind indexed kind, uint64 executableAt, bytes payload);
    event OpExecuted(uint256 indexed id, OpKind indexed kind);
    event OpCancelled(uint256 indexed id, OpKind indexed kind);

    /* -------------------------------------------------------------------- */
    /*                                ERRORS                                */
    /* -------------------------------------------------------------------- */

    error RateLimitISM_ZeroAddress();
    error RateLimitISM_BadOpTimelock(uint64 value);
    error RateLimitISM_OnlyMailbox(address caller);
    error RateLimitISM_InvalidOpId(uint256 id);
    error RateLimitISM_OpAlreadyExecuted(uint256 id);
    error RateLimitISM_OpAlreadyCancelled(uint256 id);
    error RateLimitISM_OpTimelockNotElapsed(uint64 executableAt, uint64 nowTs);

    /* -------------------------------------------------------------------- */
    /*                              CONSTRUCTOR                             */
    /* -------------------------------------------------------------------- */

    constructor(address owner_, address mailbox_, uint128 dailyCapWei_, uint64 opTimelock_)
        Ownable(owner_)
    {
        if (owner_ == address(0)) revert RateLimitISM_ZeroAddress();
        if (mailbox_ == address(0)) revert RateLimitISM_ZeroAddress();
        if (opTimelock_ < MIN_OP_TIMELOCK || opTimelock_ > MAX_OP_TIMELOCK) {
            revert RateLimitISM_BadOpTimelock(opTimelock_);
        }
        mailbox = mailbox_;
        dailyCapWei = dailyCapWei_;
        opTimelock = opTimelock_;
    }

    /* -------------------------------------------------------------------- */
    /*                                  ISM                                 */
    /* -------------------------------------------------------------------- */

    /// @inheritdoc IInterchainSecurityModule
    function moduleType() external pure returns (uint8) {
        return 6;
    }

    /// @inheritdoc IInterchainSecurityModule
    /// @dev Restricted to `mailbox`. Body must be `abi.encode(BridgeMessage)`
    ///      (256 bytes after the 77-byte Hyperlane header). A malformed
    ///      message returns false rather than reverting so the mailbox
    ///      surface stays uniform — but the body length check is strict.
    function verify(
        bytes calldata,
        /* _metadata */
        bytes calldata _message
    )
        external
        returns (bool)
    {
        if (msg.sender != mailbox) revert RateLimitISM_OnlyMailbox(msg.sender);
        if (_message.length < 77 + 32 * 8) return false;
        bytes calldata body = _message[77:];
        if (body.length != 32 * 8) return false;

        BridgeMessage memory m = abi.decode(body, (BridgeMessage));
        return _consume(m.amount);
    }

    /// @notice Off-chain accessor that mirrors `verify`'s budget logic
    /// without mutating state.
    function wouldFit(uint128 amount) external view returns (bool) {
        uint32 today = uint32(block.timestamp / 1 days);
        uint128 usedNow = today == currentDayUtc ? dailyUsedWei : 0;
        uint256 next = uint256(usedNow) + uint256(amount);
        return next <= uint256(dailyCapWei);
    }

    /// @dev Internal. Rolls the day if needed, accumulates if within budget,
    ///      emits the resulting state for off-chain monitors. Returns the
    ///      accept/reject decision; the caller treats `false` as a reject.
    function _consume(uint128 amount) internal returns (bool) {
        uint32 today = uint32(block.timestamp / 1 days);
        uint128 usedNow = dailyUsedWei;
        if (today != currentDayUtc) {
            usedNow = 0;
            currentDayUtc = today;
        }

        uint256 next = uint256(usedNow) + uint256(amount);
        if (next > uint256(dailyCapWei)) {
            // Persist a roll if it happened so the `RejectedOverCap` event
            // is consistent with state, but do not consume any budget.
            if (dailyUsedWei != usedNow) {
                dailyUsedWei = usedNow;
            }
            emit RejectedOverCap(amount, usedNow, dailyCapWei, today);
            return false;
        }

        dailyUsedWei = uint128(next);
        emit Verified(amount, uint128(next), today);
        return true;
    }

    /* -------------------------------------------------------------------- */
    /*                         OWNER TIMELOCKED OPS                         */
    /* -------------------------------------------------------------------- */

    function requestSetDailyCap(uint128 newCap) external onlyOwner returns (uint256 id) {
        return _request(OpKind.SET_DAILY_CAP, abi.encode(newCap));
    }

    function requestSetMailbox(address newMailbox) external onlyOwner returns (uint256 id) {
        if (newMailbox == address(0)) revert RateLimitISM_ZeroAddress();
        return _request(OpKind.SET_MAILBOX, abi.encode(newMailbox));
    }

    function executeOp(uint256 id) external onlyOwner {
        PendingOp storage op = pendingOps[id];
        if (op.kind == OpKind.NONE) revert RateLimitISM_InvalidOpId(id);
        if (op.executed) revert RateLimitISM_OpAlreadyExecuted(id);
        if (op.cancelled) revert RateLimitISM_OpAlreadyCancelled(id);
        if (block.timestamp < op.executableAt) {
            revert RateLimitISM_OpTimelockNotElapsed(op.executableAt, uint64(block.timestamp));
        }
        op.executed = true;

        if (op.kind == OpKind.SET_DAILY_CAP) {
            uint128 newCap = abi.decode(op.payload, (uint128));
            uint128 old = dailyCapWei;
            dailyCapWei = newCap;
            emit DailyCapChanged(old, newCap);
        } else if (op.kind == OpKind.SET_MAILBOX) {
            address newMailbox = abi.decode(op.payload, (address));
            address old = mailbox;
            mailbox = newMailbox;
            emit MailboxRotated(old, newMailbox);
        }

        emit OpExecuted(id, op.kind);
    }

    function cancelOp(uint256 id) external onlyOwner {
        PendingOp storage op = pendingOps[id];
        if (op.kind == OpKind.NONE) revert RateLimitISM_InvalidOpId(id);
        if (op.executed) revert RateLimitISM_OpAlreadyExecuted(id);
        if (op.cancelled) revert RateLimitISM_OpAlreadyCancelled(id);
        op.cancelled = true;
        emit OpCancelled(id, op.kind);
    }

    function _request(OpKind kind, bytes memory payload) internal returns (uint256 id) {
        unchecked {
            id = ++opCounter;
        }
        uint64 executableAt = uint64(block.timestamp + opTimelock);
        pendingOps[id] = PendingOp({
            kind: kind,
            executableAt: executableAt,
            executed: false,
            cancelled: false,
            payload: payload
        });
        emit OpRequested(id, kind, executableAt, payload);
    }
}
