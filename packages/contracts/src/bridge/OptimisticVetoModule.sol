// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IBridgeMinter, VetoReason} from "./IBridgeMinter.sol";

/// @title OptimisticVetoModule
/// @notice Wraps the operator's veto authority over `BridgeMinter` on the
/// destination chains (Ethereum + BNB Chain). A single hot `vetoKey` (run by
/// the watcher bot) plus an arbitrary set of `authorizedVetoers` (e.g., a
/// future multi-sig or backup operator) can forward `vetoClaimManual` calls to
/// the minter. Separating this from `BridgeMinter` lets the operator swap the
/// veto policy (rotate the bot key, expand the vetoer set, layer a multi-sig
/// in front) without touching the minter or its mint accounting.
///
/// Security posture:
/// - Vetoes are deny-only: this module cannot mint, transfer, or unblock
///   anything. The worst it can do if compromised is grief by vetoing
///   legitimate claims (DoS), which the operator can recover from by rotating
///   the key.
/// - Adding new authority (key rotation, new vetoer) is timelocked. Removing
///   authority (deauthorize) is instant — security-positive operations should
///   not be slowed down.
contract OptimisticVetoModule is Ownable2Step {
    /* -------------------------------------------------------------------- */
    /*                              IMMUTABLES                              */
    /* -------------------------------------------------------------------- */

    IBridgeMinter public immutable minter;
    uint64 public immutable opTimelock;

    /* -------------------------------------------------------------------- */
    /*                                STATE                                 */
    /* -------------------------------------------------------------------- */

    /// @notice The hot key the watcher bot signs with. May be the zero address
    /// at deploy; promote post-deploy via `requestRotateVetoKey` /
    /// `executeOp`.
    address public vetoKey;

    /// @notice Additional addresses that can also forward vetoes. Used for
    /// cold backup keys, multi-sig wrappers, or migration windows.
    mapping(address vetoer => bool authorized) public authorizedVetoers;

    /* -------------------------------------------------------------------- */
    /*                          OWNER TIMELOCK                              */
    /* -------------------------------------------------------------------- */

    enum OpKind {
        NONE,
        ROTATE_VETO_KEY,
        AUTHORIZE_VETOER
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

    event VetoForwarded(bytes32 indexed nonce, address indexed vetoer, VetoReason reason);
    event VetoKeyRotated(address indexed oldKey, address indexed newKey);
    event VetoerAuthorized(address indexed vetoer);
    event VetoerDeauthorized(address indexed vetoer);

    event OpRequested(uint256 indexed id, OpKind indexed kind, uint64 executableAt, bytes payload);
    event OpExecuted(uint256 indexed id, OpKind indexed kind);
    event OpCancelled(uint256 indexed id, OpKind indexed kind);

    /* -------------------------------------------------------------------- */
    /*                                ERRORS                                */
    /* -------------------------------------------------------------------- */

    error OptimisticVeto_ZeroAddress();
    error OptimisticVeto_UnauthorizedVetoer(address sender);
    error OptimisticVeto_AlreadyAuthorized(address vetoer);
    error OptimisticVeto_NotAuthorized(address vetoer);
    error OptimisticVeto_InvalidOpId(uint256 id);
    error OptimisticVeto_OpAlreadyExecuted(uint256 id);
    error OptimisticVeto_OpAlreadyCancelled(uint256 id);
    error OptimisticVeto_OpTimelockNotElapsed(uint64 executableAt, uint64 nowTs);

    /* -------------------------------------------------------------------- */
    /*                              CONSTRUCTOR                             */
    /* -------------------------------------------------------------------- */

    /// @param owner_       Owner of this module. Should match `BridgeMinter.owner`
    ///                     so key rotations are authorized by the same EOA / contract.
    /// @param minter_      The `BridgeMinter` instance this module wraps.
    /// @param opTimelock_  Delay between `request*` and `executeOp` for
    ///                     authority-expanding ops. 24h per spec §5.2.
    constructor(address owner_, IBridgeMinter minter_, uint64 opTimelock_) Ownable(owner_) {
        if (address(minter_) == address(0)) revert OptimisticVeto_ZeroAddress();
        minter = minter_;
        opTimelock = opTimelock_;
    }

    /* -------------------------------------------------------------------- */
    /*                                  VETO                                */
    /* -------------------------------------------------------------------- */

    /// @notice Forward a veto for `nonce` to the bridge minter. Caller must be
    /// the active `vetoKey` or an `authorizedVetoers[caller] == true` address.
    /// The reason is opaque to this module — it is recorded by the minter and
    /// surfaced in events for incident comms (per design doc §6.5).
    function veto(bytes32 nonce, VetoReason reason) external {
        if (msg.sender != vetoKey && !authorizedVetoers[msg.sender]) {
            revert OptimisticVeto_UnauthorizedVetoer(msg.sender);
        }
        emit VetoForwarded(nonce, msg.sender, reason);
        minter.vetoClaimManual(nonce, reason);
    }

    /* -------------------------------------------------------------------- */
    /*                       SECURITY-POSITIVE (INSTANT)                    */
    /* -------------------------------------------------------------------- */

    /// @notice Remove a vetoer from the authorized set. Instant per spec §5.2:
    /// shrinking authority is always safe and should not be timelocked.
    function deauthorizeVetoer(address vetoer) external onlyOwner {
        if (!authorizedVetoers[vetoer]) revert OptimisticVeto_NotAuthorized(vetoer);
        delete authorizedVetoers[vetoer];
        emit VetoerDeauthorized(vetoer);
    }

    /* -------------------------------------------------------------------- */
    /*                         OWNER TIMELOCKED OPS                         */
    /* -------------------------------------------------------------------- */

    /// @notice Schedule a rotation of `vetoKey` to `newKey`. The new key is
    /// inactive until `executeOp(id)` is called after `opTimelock` has elapsed.
    function requestRotateVetoKey(address newKey) external onlyOwner returns (uint256 id) {
        if (newKey == address(0)) revert OptimisticVeto_ZeroAddress();
        return _request(OpKind.ROTATE_VETO_KEY, abi.encode(newKey));
    }

    /// @notice Schedule promoting `vetoer` into `authorizedVetoers`.
    function requestAuthorizeVetoer(address vetoer) external onlyOwner returns (uint256 id) {
        if (vetoer == address(0)) revert OptimisticVeto_ZeroAddress();
        if (authorizedVetoers[vetoer]) revert OptimisticVeto_AlreadyAuthorized(vetoer);
        return _request(OpKind.AUTHORIZE_VETOER, abi.encode(vetoer));
    }

    /// @notice Apply a previously-requested op once its timelock has elapsed.
    function executeOp(uint256 id) external onlyOwner {
        PendingOp storage op = pendingOps[id];
        if (op.kind == OpKind.NONE) revert OptimisticVeto_InvalidOpId(id);
        if (op.executed) revert OptimisticVeto_OpAlreadyExecuted(id);
        if (op.cancelled) revert OptimisticVeto_OpAlreadyCancelled(id);
        if (block.timestamp < op.executableAt) {
            revert OptimisticVeto_OpTimelockNotElapsed(op.executableAt, uint64(block.timestamp));
        }
        op.executed = true;

        if (op.kind == OpKind.ROTATE_VETO_KEY) {
            address newKey = abi.decode(op.payload, (address));
            address oldKey = vetoKey;
            vetoKey = newKey;
            emit VetoKeyRotated(oldKey, newKey);
        } else if (op.kind == OpKind.AUTHORIZE_VETOER) {
            address vetoer = abi.decode(op.payload, (address));
            authorizedVetoers[vetoer] = true;
            emit VetoerAuthorized(vetoer);
        }

        emit OpExecuted(id, op.kind);
    }

    /// @notice Abort a pending op before it is executed.
    function cancelOp(uint256 id) external onlyOwner {
        PendingOp storage op = pendingOps[id];
        if (op.kind == OpKind.NONE) revert OptimisticVeto_InvalidOpId(id);
        if (op.executed) revert OptimisticVeto_OpAlreadyExecuted(id);
        if (op.cancelled) revert OptimisticVeto_OpAlreadyCancelled(id);
        op.cancelled = true;
        emit OpCancelled(id, op.kind);
    }

    /* -------------------------------------------------------------------- */
    /*                              INTERNAL                                */
    /* -------------------------------------------------------------------- */

    function _request(OpKind kind, bytes memory payload) internal returns (uint256 id) {
        opCounter += 1;
        id = opCounter;
        uint64 executableAt = uint64(block.timestamp) + opTimelock;
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
