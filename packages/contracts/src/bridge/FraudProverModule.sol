// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {BridgeMessage, IBridgeMinter, VetoReason} from "./IBridgeMinter.sol";

/// @title FraudProverModule
/// @notice Independent, permissionless veto path for the Phase 3 bridge.
/// Anyone can submit a Merkle proof showing that the on-Etica deposit a
/// pending withdrawal claim references doesn't actually match what the claim
/// asserts. On a successful proof the bond is slashed by the minter, and 25%
/// of the slash is paid to the prover (per design doc §6.4 — 25/50/25 split).
///
/// The module verifies cryptographic proof only. It cannot mint, transfer, or
/// release funds. Worst case if compromised: spurious veto attempts, all of
/// which revert at the minter (which independently confirms the supplied
/// `actualDeposit` doesn't match the stored claim before slashing).
///
/// Etica block roots are pushed in by a trusted sender on the Etica chain via
/// Hyperlane — typically a small `EtcaBlockOracle` contract that the operator
/// runs alongside the bridge and that any Hyperlane validator can dispatch
/// roots from. This module is agnostic to the oracle's internals; it only
/// trusts (a) the local Hyperlane mailbox as caller and (b) one configured
/// sender address on the Etica domain.
contract FraudProverModule is Ownable2Step {
    /* -------------------------------------------------------------------- */
    /*                              IMMUTABLES                              */
    /* -------------------------------------------------------------------- */

    IBridgeMinter public immutable minter;
    address public immutable hyperlaneMailbox;
    uint32 public immutable etcaDomain;
    uint64 public immutable opTimelock;

    /* -------------------------------------------------------------------- */
    /*                                STATE                                 */
    /* -------------------------------------------------------------------- */

    /// @notice Etica deposit-tree roots indexed by Etica block number. A
    /// non-zero entry means the root has been attested via Hyperlane; the
    /// module will accept Merkle proofs against it.
    mapping(uint64 etcaBlockNumber => bytes32 root) public etcaBlockRoots;

    /// @notice The single address on `etcaDomain` allowed to push roots.
    /// Set post-deploy via the timelocked op flow once the Etica-side oracle
    /// has been deployed.
    bytes32 public trustedRootSender;

    /* -------------------------------------------------------------------- */
    /*                          OWNER TIMELOCK                              */
    /* -------------------------------------------------------------------- */

    enum OpKind {
        NONE,
        SET_TRUSTED_ROOT_SENDER
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

    event EtcaBlockRootRecorded(uint64 indexed blockNumber, bytes32 root);
    event FraudProven(bytes32 indexed claimNonce, address indexed prover, uint64 etcaBlockNumber);
    event TrustedRootSenderUpdated(bytes32 oldSender, bytes32 newSender);

    event OpRequested(uint256 indexed id, OpKind indexed kind, uint64 executableAt, bytes payload);
    event OpExecuted(uint256 indexed id, OpKind indexed kind);
    event OpCancelled(uint256 indexed id, OpKind indexed kind);

    /* -------------------------------------------------------------------- */
    /*                                ERRORS                                */
    /* -------------------------------------------------------------------- */

    error FraudProver_ZeroAddress();
    error FraudProver_OnlyMailbox(address caller);
    error FraudProver_UntrustedOrigin(uint32 origin);
    error FraudProver_UntrustedSender(bytes32 sender);
    error FraudProver_TrustedSenderUnset();
    error FraudProver_InvalidRoot();
    error FraudProver_RootNotAttested(uint64 blockNumber);
    error FraudProver_RootAlreadyRecorded(uint64 blockNumber);
    error FraudProver_ProofInvalid();
    error FraudProver_BodyMalformed();

    error FraudProver_InvalidOpId(uint256 id);
    error FraudProver_OpAlreadyExecuted(uint256 id);
    error FraudProver_OpAlreadyCancelled(uint256 id);
    error FraudProver_OpTimelockNotElapsed(uint64 executableAt, uint64 nowTs);

    /* -------------------------------------------------------------------- */
    /*                              CONSTRUCTOR                             */
    /* -------------------------------------------------------------------- */

    /// @param owner_              Owner of this module (key rotations use the
    ///                            timelocked op flow; matches the rest of the
    ///                            bridge contracts).
    /// @param minter_             The destination-chain `BridgeMinter`.
    /// @param hyperlaneMailbox_   Local Hyperlane mailbox; only it may call
    ///                            `handle`.
    /// @param etcaDomain_         Hyperlane domain ID for the Etica chain (61803).
    /// @param opTimelock_         Delay between `request*` and `executeOp`.
    constructor(
        address owner_,
        IBridgeMinter minter_,
        address hyperlaneMailbox_,
        uint32 etcaDomain_,
        uint64 opTimelock_
    ) Ownable(owner_) {
        if (address(minter_) == address(0)) {
            revert FraudProver_ZeroAddress();
        }
        if (hyperlaneMailbox_ == address(0)) revert FraudProver_ZeroAddress();
        minter = minter_;
        hyperlaneMailbox = hyperlaneMailbox_;
        etcaDomain = etcaDomain_;
        opTimelock = opTimelock_;
    }

    /* -------------------------------------------------------------------- */
    /*                             FRAUD PROOF                              */
    /* -------------------------------------------------------------------- */

    /// @notice Permissionless. Submit a Merkle proof that `actualDeposit` is
    /// the deposit recorded in Etica block `etcaBlockNumber`. The minter
    /// independently verifies that this contradicts the pending claim before
    /// slashing the bond and crediting `msg.sender` with the prover share.
    function proveAndVeto(
        bytes32 claimNonce,
        uint64 etcaBlockNumber,
        BridgeMessage calldata actualDeposit,
        bytes32[] calldata merkleProof
    ) external {
        bytes32 root = etcaBlockRoots[etcaBlockNumber];
        if (root == bytes32(0)) revert FraudProver_RootNotAttested(etcaBlockNumber);

        bytes32 leaf = _leafOf(actualDeposit);
        if (!MerkleProof.verifyCalldata(merkleProof, root, leaf)) {
            revert FraudProver_ProofInvalid();
        }

        emit FraudProven(claimNonce, msg.sender, etcaBlockNumber);
        // Minter compares actualDeposit against the stored claim; reverts if
        // they actually match (no fraud) before slashing the bond.
        minter.vetoClaimWithProof(claimNonce, actualDeposit, msg.sender);
    }

    /// @notice Compute the canonical leaf for a `BridgeMessage`. Public so
    /// off-chain provers can build trees against the same encoding the
    /// contract verifies against.
    function leafOf(BridgeMessage calldata m) external pure returns (bytes32) {
        return _leafOf(m);
    }

    /* -------------------------------------------------------------------- */
    /*                       INBOUND ROOT (HYPERLANE)                       */
    /* -------------------------------------------------------------------- */

    /// @notice Hyperlane callback. The mailbox forwards messages from the
    /// Etica-side oracle here; body is `abi.encode(uint64 blockNumber, bytes32 root)`.
    /// Roots are write-once per block number — re-attesting the same block is
    /// rejected so a compromised oracle cannot rewrite history.
    function handle(uint32 origin, bytes32 sender, bytes calldata body) external payable {
        if (msg.sender != hyperlaneMailbox) revert FraudProver_OnlyMailbox(msg.sender);
        if (origin != etcaDomain) revert FraudProver_UntrustedOrigin(origin);
        bytes32 expected = trustedRootSender;
        if (expected == bytes32(0)) revert FraudProver_TrustedSenderUnset();
        if (sender != expected) revert FraudProver_UntrustedSender(sender);
        if (body.length != 64) revert FraudProver_BodyMalformed();

        (uint64 blockNumber, bytes32 root) = abi.decode(body, (uint64, bytes32));
        if (root == bytes32(0)) revert FraudProver_InvalidRoot();
        if (etcaBlockRoots[blockNumber] != bytes32(0)) {
            revert FraudProver_RootAlreadyRecorded(blockNumber);
        }
        etcaBlockRoots[blockNumber] = root;
        emit EtcaBlockRootRecorded(blockNumber, root);
    }

    /* -------------------------------------------------------------------- */
    /*                         OWNER TIMELOCKED OPS                         */
    /* -------------------------------------------------------------------- */

    /// @notice Schedule setting the single trusted sender on `etcaDomain`
    /// allowed to push roots. The sender is supplied as a left-padded
    /// `bytes32` to match Hyperlane's canonical address representation.
    function requestSetTrustedRootSender(bytes32 newSender)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (newSender == bytes32(0)) revert FraudProver_ZeroAddress();
        return _request(OpKind.SET_TRUSTED_ROOT_SENDER, abi.encode(newSender));
    }

    function executeOp(uint256 id) external onlyOwner {
        PendingOp storage op = pendingOps[id];
        if (op.kind == OpKind.NONE) revert FraudProver_InvalidOpId(id);
        if (op.executed) revert FraudProver_OpAlreadyExecuted(id);
        if (op.cancelled) revert FraudProver_OpAlreadyCancelled(id);
        if (block.timestamp < op.executableAt) {
            revert FraudProver_OpTimelockNotElapsed(op.executableAt, uint64(block.timestamp));
        }
        op.executed = true;

        if (op.kind == OpKind.SET_TRUSTED_ROOT_SENDER) {
            bytes32 newSender = abi.decode(op.payload, (bytes32));
            bytes32 oldSender = trustedRootSender;
            trustedRootSender = newSender;
            emit TrustedRootSenderUpdated(oldSender, newSender);
        }

        emit OpExecuted(id, op.kind);
    }

    function cancelOp(uint256 id) external onlyOwner {
        PendingOp storage op = pendingOps[id];
        if (op.kind == OpKind.NONE) revert FraudProver_InvalidOpId(id);
        if (op.executed) revert FraudProver_OpAlreadyExecuted(id);
        if (op.cancelled) revert FraudProver_OpAlreadyCancelled(id);
        op.cancelled = true;
        emit OpCancelled(id, op.kind);
    }

    /* -------------------------------------------------------------------- */
    /*                              INTERNAL                                */
    /* -------------------------------------------------------------------- */

    function _leafOf(BridgeMessage calldata m) internal pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

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
