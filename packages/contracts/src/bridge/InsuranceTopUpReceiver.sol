// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title InsuranceTopUpReceiver
/// @notice Etica-side handler for cross-chain insurance top-up notices
///         dispatched by `BridgeMinter` instances on Ethereum and BNB Chain.
///
///         When `sweepInsuranceShare` runs on the destination side, it
///         (a) drains the local native-gas accumulator into a configured
///         operator recipient and (b) optionally dispatches a Hyperlane
///         message recording how much native gas was swept. This receiver
///         is the inbound handler for those notices.
///
///         The actual ETX top-up of `BridgeInsuranceFund` is an operator
///         off-chain settlement step (swap native → ETX on the destination
///         side, bridge ETX through `BridgeVault`, deposit to the fund).
///         This contract exists to create the on-chain audit trail of
///         pending top-up obligations and lets the operator mark them
///         settled once the corresponding ETX deposit has landed.
///
/// Trust model:
///   - Only the Hyperlane mailbox can call `handle`.
///   - For each `origin` domain, `trustedSender[origin]` must match the
///     incoming `sender`. Wiring is owner-controlled via 24h-timelocked
///     ops, mirroring the `BridgeMinter` admin pattern.
///   - `markSettled` is owner-only and idempotent: each notice can only
///     be settled once. The owner attests off-chain that the ETX deposit
///     for the corresponding native amount has been made; this contract
///     stores the attestation timestamp and ETX amount for transparency.
contract InsuranceTopUpReceiver is Ownable2Step {
    /* -------------------------------------------------------------------- */
    /*                              CONSTANTS                               */
    /* -------------------------------------------------------------------- */

    uint64 public constant MIN_OP_TIMELOCK = 1 hours;
    uint64 public constant MAX_OP_TIMELOCK = 30 days;

    /* -------------------------------------------------------------------- */
    /*                                STATE                                 */
    /* -------------------------------------------------------------------- */

    /// @notice Hyperlane mailbox on Etica.
    address public immutable hyperlaneMailbox;

    /// @notice Delay between an owner `request*` and `executeOp`.
    uint64 public immutable opTimelock;

    /// @notice Trusted `BridgeMinter` (as bytes32) per origin domain.
    /// Inbound notices are accepted only if `sender == trustedSender[origin]`.
    mapping(uint32 origin => bytes32 trustedSender) public trustedSender;

    struct TopUpNotice {
        uint128 amountNativeWei;
        uint32 origin;
        uint64 receivedAt;
        uint64 settledAt;
        uint128 settledEtxAmount;
        address settledBy;
        bool settled;
    }

    /// @notice Cross-chain insurance top-up notices, keyed by `noticeId`
    /// from the `BridgeMinter` dispatch.
    mapping(bytes32 noticeId => TopUpNotice) public notices;

    /// @notice Lifetime native-gas total received per origin domain.
    mapping(uint32 origin => uint128) public lifetimeNativeReceived;

    /// @notice Lifetime native-gas total marked settled per origin domain.
    mapping(uint32 origin => uint128) public lifetimeNativeSettled;

    /* -------------------------------------------------------------------- */
    /*                          OWNER OP TIMELOCK                           */
    /* -------------------------------------------------------------------- */

    enum OpKind {
        NONE,
        SET_TRUSTED_SENDER
    }

    struct PendingOp {
        OpKind kind;
        uint64 executableAt;
        bool executed;
        bool cancelled;
        bytes payload;
    }

    mapping(uint256 id => PendingOp) public pendingOps;
    uint256 public nextOpId;

    /* -------------------------------------------------------------------- */
    /*                                EVENTS                                */
    /* -------------------------------------------------------------------- */

    event TrustedSenderChanged(uint32 indexed origin, bytes32 trustedSender);
    event NoticeReceived(
        bytes32 indexed noticeId,
        uint32 indexed origin,
        uint128 amountNativeWei,
        uint64 sourceTimestamp
    );
    event NoticeSettled(
        bytes32 indexed noticeId, address indexed settler, uint128 etxAmount, uint64 settledAt
    );

    event OpRequested(uint256 indexed id, OpKind indexed kind, uint64 executableAt, bytes payload);
    event OpExecuted(uint256 indexed id, OpKind indexed kind);
    event OpCancelled(uint256 indexed id, OpKind indexed kind);

    /* -------------------------------------------------------------------- */
    /*                                ERRORS                                */
    /* -------------------------------------------------------------------- */

    error TopUpReceiver_ZeroAddress();
    error TopUpReceiver_ZeroAmount();
    error TopUpReceiver_OnlyMailbox(address caller);
    error TopUpReceiver_UntrustedOrigin(uint32 origin);
    error TopUpReceiver_UntrustedSender(bytes32 sender);
    error TopUpReceiver_MalformedBody();
    error TopUpReceiver_NoticeAlreadyReceived(bytes32 noticeId);
    error TopUpReceiver_UnknownNotice(bytes32 noticeId);
    error TopUpReceiver_AlreadySettled(bytes32 noticeId);
    error TopUpReceiver_InvalidOpId(uint256 id);
    error TopUpReceiver_OpAlreadyExecuted(uint256 id);
    error TopUpReceiver_OpAlreadyCancelled(uint256 id);
    error TopUpReceiver_OpTimelockNotElapsed(uint64 executableAt, uint64 nowTs);
    error TopUpReceiver_BadOpTimelock(uint64 value);

    /* -------------------------------------------------------------------- */
    /*                              CONSTRUCTOR                             */
    /* -------------------------------------------------------------------- */

    constructor(address owner_, address hyperlaneMailbox_, uint64 opTimelock_) Ownable(owner_) {
        if (owner_ == address(0)) revert TopUpReceiver_ZeroAddress();
        if (hyperlaneMailbox_ == address(0)) revert TopUpReceiver_ZeroAddress();
        if (opTimelock_ < MIN_OP_TIMELOCK || opTimelock_ > MAX_OP_TIMELOCK) {
            revert TopUpReceiver_BadOpTimelock(opTimelock_);
        }
        hyperlaneMailbox = hyperlaneMailbox_;
        opTimelock = opTimelock_;
    }

    /* -------------------------------------------------------------------- */
    /*                              MODIFIERS                               */
    /* -------------------------------------------------------------------- */

    modifier onlyMailbox() {
        if (msg.sender != hyperlaneMailbox) revert TopUpReceiver_OnlyMailbox(msg.sender);
        _;
    }

    /* -------------------------------------------------------------------- */
    /*                          INBOUND HYPERLANE                           */
    /* -------------------------------------------------------------------- */

    /// @notice Hyperlane callback. Records an insurance top-up notice from
    /// the `BridgeMinter` on `origin`.
    /// @dev Body layout (each field 32-byte ABI-padded):
    ///   abi.encode(bytes32 noticeId, uint32 srcDomain, uint128 amountNativeWei, uint64 timestamp)
    function handle(uint32 origin, bytes32 sender, bytes calldata body)
        external
        payable
        onlyMailbox
    {
        bytes32 expected = trustedSender[origin];
        if (expected == bytes32(0)) revert TopUpReceiver_UntrustedOrigin(origin);
        if (sender != expected) revert TopUpReceiver_UntrustedSender(sender);
        if (body.length != 32 * 4) revert TopUpReceiver_MalformedBody();

        (bytes32 noticeId, uint32 srcDomain, uint128 amount, uint64 srcTs) =
            abi.decode(body, (bytes32, uint32, uint128, uint64));
        if (srcDomain != origin) revert TopUpReceiver_UntrustedOrigin(srcDomain);
        if (amount == 0) revert TopUpReceiver_ZeroAmount();
        if (notices[noticeId].receivedAt != 0) {
            revert TopUpReceiver_NoticeAlreadyReceived(noticeId);
        }

        notices[noticeId] = TopUpNotice({
            amountNativeWei: amount,
            origin: origin,
            receivedAt: uint64(block.timestamp),
            settledAt: 0,
            settledEtxAmount: 0,
            settledBy: address(0),
            settled: false
        });
        lifetimeNativeReceived[origin] += amount;

        emit NoticeReceived(noticeId, origin, amount, srcTs);
    }

    /* -------------------------------------------------------------------- */
    /*                              SETTLEMENT                              */
    /* -------------------------------------------------------------------- */

    /// @notice Marks a previously received notice as settled by the operator.
    /// @dev `etxAmount` is the operator's attested ETX deposit into
    ///      `BridgeInsuranceFund` corresponding to this notice. This contract
    ///      does not enforce a minimum conversion ratio — that policy lives
    ///      off-chain.
    function markSettled(bytes32 noticeId, uint128 etxAmount) external onlyOwner {
        TopUpNotice storage n = notices[noticeId];
        if (n.receivedAt == 0) revert TopUpReceiver_UnknownNotice(noticeId);
        if (n.settled) revert TopUpReceiver_AlreadySettled(noticeId);
        if (etxAmount == 0) revert TopUpReceiver_ZeroAmount();

        n.settled = true;
        n.settledAt = uint64(block.timestamp);
        n.settledEtxAmount = etxAmount;
        n.settledBy = msg.sender;
        lifetimeNativeSettled[n.origin] += n.amountNativeWei;

        emit NoticeSettled(noticeId, msg.sender, etxAmount, uint64(block.timestamp));
    }

    /* -------------------------------------------------------------------- */
    /*                          OWNER TIMELOCK OPS                          */
    /* -------------------------------------------------------------------- */

    function requestSetTrustedSender(uint32 origin, bytes32 newTrusted)
        external
        onlyOwner
        returns (uint256 id)
    {
        return _request(OpKind.SET_TRUSTED_SENDER, abi.encode(origin, newTrusted));
    }

    function executeOp(uint256 id) external onlyOwner {
        PendingOp storage op = pendingOps[id];
        if (op.kind == OpKind.NONE) revert TopUpReceiver_InvalidOpId(id);
        if (op.executed) revert TopUpReceiver_OpAlreadyExecuted(id);
        if (op.cancelled) revert TopUpReceiver_OpAlreadyCancelled(id);
        if (block.timestamp < op.executableAt) {
            revert TopUpReceiver_OpTimelockNotElapsed(op.executableAt, uint64(block.timestamp));
        }

        op.executed = true;
        OpKind kind = op.kind;

        if (kind == OpKind.SET_TRUSTED_SENDER) {
            (uint32 origin, bytes32 trusted) = abi.decode(op.payload, (uint32, bytes32));
            trustedSender[origin] = trusted;
            emit TrustedSenderChanged(origin, trusted);
        }

        emit OpExecuted(id, kind);
    }

    function cancelOp(uint256 id) external onlyOwner {
        PendingOp storage op = pendingOps[id];
        if (op.kind == OpKind.NONE) revert TopUpReceiver_InvalidOpId(id);
        if (op.executed) revert TopUpReceiver_OpAlreadyExecuted(id);
        if (op.cancelled) revert TopUpReceiver_OpAlreadyCancelled(id);

        op.cancelled = true;
        emit OpCancelled(id, op.kind);
    }

    function _request(OpKind kind, bytes memory payload) internal returns (uint256 id) {
        id = nextOpId++;
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

    /* -------------------------------------------------------------------- */
    /*                                VIEWS                                 */
    /* -------------------------------------------------------------------- */

    /// @notice Native-gas total awaiting operator settlement per origin.
    function pendingNativePerOrigin(uint32 origin) external view returns (uint128) {
        return lifetimeNativeReceived[origin] - lifetimeNativeSettled[origin];
    }

    /* -------------------------------------------------------------------- */
    /*                           RESCUE / RECOVERY                          */
    /* -------------------------------------------------------------------- */

    /// @notice Recover ERC-20 tokens accidentally sent to this contract.
    function rescueERC20(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert TopUpReceiver_ZeroAddress();
        SafeERC20.safeTransfer(token, to, amount);
    }

    /// @notice Recover ETH accidentally sent to this contract.
    function rescueETH(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert TopUpReceiver_ZeroAddress();
        (bool ok,) = to.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    /// @notice Accept ETH (e.g. Hyperlane refunds or accidental sends).
    receive() external payable {}
}
