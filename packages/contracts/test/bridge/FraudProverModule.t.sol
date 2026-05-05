// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FraudProverModule} from "../../src/bridge/FraudProverModule.sol";
import {BridgeMessage, IBridgeMinter, VetoReason} from "../../src/bridge/IBridgeMinter.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Stub implementing both veto entrypoints. Records arguments and
/// optionally reverts so we can test that the module bubbles minter errors.
contract MockBridgeMinter is IBridgeMinter {
    bytes32 public lastClaimNonce;
    address public lastProver;
    BridgeMessage internal _lastDeposit;
    uint256 public proofCallCount;
    bool public shouldRevertOnProof;

    function setShouldRevertOnProof(bool v) external {
        shouldRevertOnProof = v;
    }

    function lastDeposit() external view returns (BridgeMessage memory) {
        return _lastDeposit;
    }

    function vetoClaimManual(bytes32, VetoReason) external pure override {
        revert("not used in fraud-prover tests");
    }

    function vetoClaimWithProof(
        bytes32 claimNonce,
        BridgeMessage calldata actualDeposit,
        address prover
    ) external override {
        if (shouldRevertOnProof) {
            revert("minter rejected proof");
        }
        lastClaimNonce = claimNonce;
        lastProver = prover;
        _lastDeposit = actualDeposit;
        proofCallCount += 1;
    }
}

/// @notice Mailbox stub that exposes a helper for the test harness to deliver
/// inbound `handle` messages with full control over origin + sender.
contract MockMailbox {
    FraudProverModule public module;

    function setModule(FraudProverModule m) external {
        module = m;
    }

    function deliver(uint32 origin, bytes32 sender, bytes calldata body) external {
        module.handle(origin, sender, body);
    }
}

contract FraudProverModuleTest is Test {
    MockBridgeMinter internal minter;
    MockMailbox internal mailbox;
    FraudProverModule internal fpm;

    address internal constant OWNER = address(0xF1A11);
    address internal constant ATTACKER = address(0xBAD);
    address internal constant PROVER = address(0xC0FFEE);

    uint32 internal constant ETCA_DOMAIN = 61803;
    uint32 internal constant DEST_DOMAIN = 1; // Ethereum
    uint64 internal constant OP_TIMELOCK = 24 hours;

    bytes32 internal constant TRUSTED_SENDER = bytes32(uint256(uint160(address(0xE71CA0))));

    bytes32 internal constant CLAIM_NONCE = bytes32(uint256(0xC1A1));

    function setUp() public {
        minter = new MockBridgeMinter();
        mailbox = new MockMailbox();
        fpm = new FraudProverModule(
            OWNER, IBridgeMinter(address(minter)), address(mailbox), ETCA_DOMAIN, OP_TIMELOCK
        );
        mailbox.setModule(fpm);
        _setTrustedSender(TRUSTED_SENDER);
    }

    /* -------------------------------------------------------------------- */
    /*                              HELPERS                                 */
    /* -------------------------------------------------------------------- */

    function _setTrustedSender(bytes32 sender) internal {
        vm.prank(OWNER);
        uint256 id = fpm.requestSetTrustedRootSender(sender);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        fpm.executeOp(id);
    }

    function _msg(bytes32 nonce, address recipient, uint128 amount)
        internal
        pure
        returns (BridgeMessage memory)
    {
        return BridgeMessage({
            nonce: nonce,
            srcDomain: ETCA_DOMAIN,
            destDomain: DEST_DOMAIN,
            sender: address(0xABCD),
            recipient: recipient,
            amount: amount,
            srcBlockNumber: 100,
            timestamp: 1_700_000_000
        });
    }

    function _leaf(BridgeMessage memory m) internal pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

    /// @dev Build a 2-leaf Merkle tree using OZ's sorted-pair convention.
    function _twoLeafRoot(bytes32 leafA, bytes32 leafB) internal pure returns (bytes32) {
        return leafA < leafB
            ? keccak256(abi.encodePacked(leafA, leafB))
            : keccak256(abi.encodePacked(leafB, leafA));
    }

    function _twoLeafProof(bytes32 sibling) internal pure returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = sibling;
    }

    function _deliverRoot(uint64 blockNumber, bytes32 root) internal {
        mailbox.deliver(ETCA_DOMAIN, TRUSTED_SENDER, abi.encode(blockNumber, root));
    }

    /* -------------------------------------------------------------------- */
    /*                            CONSTRUCTOR                               */
    /* -------------------------------------------------------------------- */

    function test_constructor_setsImmutables() public view {
        assertEq(address(fpm.minter()), address(minter));
        assertEq(fpm.hyperlaneMailbox(), address(mailbox));
        assertEq(fpm.etcaDomain(), ETCA_DOMAIN);
        assertEq(fpm.opTimelock(), OP_TIMELOCK);
        assertEq(fpm.owner(), OWNER);
        assertEq(fpm.trustedRootSender(), TRUSTED_SENDER);
    }

    function test_constructor_revertsOnZeroMinter() public {
        vm.expectRevert(FraudProverModule.FraudProver_ZeroAddress.selector);
        new FraudProverModule(
            OWNER, IBridgeMinter(address(0)), address(mailbox), ETCA_DOMAIN, OP_TIMELOCK
        );
    }

    function test_constructor_revertsOnZeroMailbox() public {
        vm.expectRevert(FraudProverModule.FraudProver_ZeroAddress.selector);
        new FraudProverModule(
            OWNER, IBridgeMinter(address(minter)), address(0), ETCA_DOMAIN, OP_TIMELOCK
        );
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new FraudProverModule(
            address(0), IBridgeMinter(address(minter)), address(mailbox), ETCA_DOMAIN, OP_TIMELOCK
        );
    }

    /* -------------------------------------------------------------------- */
    /*                          INBOUND ROOT (HANDLE)                       */
    /* -------------------------------------------------------------------- */

    function test_handle_recordsRoot() public {
        bytes32 root = keccak256("root-1");
        vm.expectEmit(true, false, false, true, address(fpm));
        emit FraudProverModule.EtcaBlockRootRecorded(123, root);
        _deliverRoot(123, root);
        assertEq(fpm.etcaBlockRoots(123), root);
    }

    function test_handle_revertsForNonMailbox() public {
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(FraudProverModule.FraudProver_OnlyMailbox.selector, ATTACKER)
        );
        fpm.handle(ETCA_DOMAIN, TRUSTED_SENDER, abi.encode(uint64(1), keccak256("r")));
    }

    function test_handle_revertsForUntrustedOrigin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                FraudProverModule.FraudProver_UntrustedOrigin.selector, uint32(99)
            )
        );
        mailbox.deliver(99, TRUSTED_SENDER, abi.encode(uint64(1), keccak256("r")));
    }

    function test_handle_revertsForUntrustedSender() public {
        bytes32 bogus = bytes32(uint256(uint160(address(0xDEAD))));
        vm.expectRevert(
            abi.encodeWithSelector(FraudProverModule.FraudProver_UntrustedSender.selector, bogus)
        );
        mailbox.deliver(ETCA_DOMAIN, bogus, abi.encode(uint64(1), keccak256("r")));
    }

    function test_handle_revertsBeforeTrustedSenderSet() public {
        // Spin up a fresh module that never had its trusted sender set.
        FraudProverModule fresh = new FraudProverModule(
            OWNER, IBridgeMinter(address(minter)), address(mailbox), ETCA_DOMAIN, OP_TIMELOCK
        );
        MockMailbox freshMailbox = new MockMailbox();
        freshMailbox.setModule(fresh);
        // Need a fresh module pointing at a new mailbox so msg.sender == that mailbox.
        FraudProverModule fresh2 = new FraudProverModule(
            OWNER, IBridgeMinter(address(minter)), address(freshMailbox), ETCA_DOMAIN, OP_TIMELOCK
        );
        freshMailbox.setModule(fresh2);
        vm.expectRevert(FraudProverModule.FraudProver_TrustedSenderUnset.selector);
        freshMailbox.deliver(ETCA_DOMAIN, TRUSTED_SENDER, abi.encode(uint64(1), keccak256("r")));
        // Silence unused warning.
        fresh;
    }

    function test_handle_revertsOnZeroRoot() public {
        vm.expectRevert(FraudProverModule.FraudProver_InvalidRoot.selector);
        _deliverRoot(1, bytes32(0));
    }

    function test_handle_revertsOnDuplicateBlock() public {
        bytes32 root = keccak256("r1");
        _deliverRoot(7, root);
        vm.expectRevert(
            abi.encodeWithSelector(
                FraudProverModule.FraudProver_RootAlreadyRecorded.selector, uint64(7)
            )
        );
        _deliverRoot(7, keccak256("r2"));
    }

    function test_handle_revertsOnMalformedBody() public {
        vm.expectRevert(FraudProverModule.FraudProver_BodyMalformed.selector);
        mailbox.deliver(ETCA_DOMAIN, TRUSTED_SENDER, hex"1234");
    }

    /* -------------------------------------------------------------------- */
    /*                            PROVE & VETO                              */
    /* -------------------------------------------------------------------- */

    function test_proveAndVeto_revertsOnUnattestedBlock() public {
        BridgeMessage memory m = _msg(bytes32(uint256(0x1)), address(0xAA), 100e18);
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(
            abi.encodeWithSelector(
                FraudProverModule.FraudProver_RootNotAttested.selector, uint64(50)
            )
        );
        fpm.proveAndVeto(CLAIM_NONCE, 50, m, proof);
    }

    function test_proveAndVeto_revertsOnInvalidProof() public {
        BridgeMessage memory m = _msg(bytes32(uint256(0x1)), address(0xAA), 100e18);
        BridgeMessage memory other = _msg(bytes32(uint256(0x2)), address(0xBB), 200e18);
        bytes32 root = _twoLeafRoot(_leaf(m), _leaf(other));
        _deliverRoot(50, root);

        // Submit proof with the wrong sibling.
        bytes32[] memory wrongProof = _twoLeafProof(keccak256("nope"));
        vm.expectRevert(FraudProverModule.FraudProver_ProofInvalid.selector);
        fpm.proveAndVeto(CLAIM_NONCE, 50, m, wrongProof);
    }

    function test_proveAndVeto_happyPath() public {
        BridgeMessage memory m = _msg(bytes32(uint256(0xABCDEF)), address(0xAA), 100e18);
        BridgeMessage memory other = _msg(bytes32(uint256(0x123456)), address(0xBB), 200e18);
        bytes32 root = _twoLeafRoot(_leaf(m), _leaf(other));
        _deliverRoot(50, root);

        bytes32[] memory proof = _twoLeafProof(_leaf(other));

        vm.expectEmit(true, true, false, true, address(fpm));
        emit FraudProverModule.FraudProven(CLAIM_NONCE, PROVER, 50);
        vm.prank(PROVER);
        fpm.proveAndVeto(CLAIM_NONCE, 50, m, proof);

        assertEq(minter.proofCallCount(), 1);
        assertEq(minter.lastClaimNonce(), CLAIM_NONCE);
        assertEq(minter.lastProver(), PROVER);
        assertEq(minter.lastDeposit().nonce, m.nonce);
        assertEq(minter.lastDeposit().amount, m.amount);
        assertEq(minter.lastDeposit().recipient, m.recipient);
    }

    function test_proveAndVeto_singleLeafTree() public {
        // Single-leaf tree: root == leaf, proof empty.
        BridgeMessage memory m = _msg(bytes32(uint256(0x9999)), address(0xAA), 50e18);
        bytes32 root = _leaf(m);
        _deliverRoot(70, root);

        bytes32[] memory empty = new bytes32[](0);
        vm.prank(PROVER);
        fpm.proveAndVeto(CLAIM_NONCE, 70, m, empty);
        assertEq(minter.proofCallCount(), 1);
    }

    function test_proveAndVeto_bubblesMinterRevert() public {
        BridgeMessage memory m = _msg(bytes32(uint256(0xABCDEF)), address(0xAA), 100e18);
        bytes32 root = _leaf(m);
        _deliverRoot(50, root);

        minter.setShouldRevertOnProof(true);
        bytes32[] memory empty = new bytes32[](0);
        vm.expectRevert(bytes("minter rejected proof"));
        vm.prank(PROVER);
        fpm.proveAndVeto(CLAIM_NONCE, 50, m, empty);
    }

    function test_leafOf_matchesInternalEncoding() public view {
        BridgeMessage memory m = _msg(bytes32(uint256(0xABCDEF)), address(0xAA), 100e18);
        assertEq(fpm.leafOf(m), keccak256(abi.encode(m)));
    }

    /* -------------------------------------------------------------------- */
    /*                         OWNER TIMELOCKED OPS                         */
    /* -------------------------------------------------------------------- */

    function test_requestSetTrustedRootSender_onlyOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        fpm.requestSetTrustedRootSender(bytes32(uint256(1)));
    }

    function test_requestSetTrustedRootSender_revertsOnZero() public {
        vm.prank(OWNER);
        vm.expectRevert(FraudProverModule.FraudProver_ZeroAddress.selector);
        fpm.requestSetTrustedRootSender(bytes32(0));
    }

    function test_executeOp_revertsBeforeTimelock() public {
        vm.prank(OWNER);
        uint256 id = fpm.requestSetTrustedRootSender(bytes32(uint256(0xFEED)));
        uint64 readyAt = uint64(block.timestamp) + OP_TIMELOCK;
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                FraudProverModule.FraudProver_OpTimelockNotElapsed.selector,
                readyAt,
                uint64(block.timestamp)
            )
        );
        fpm.executeOp(id);
    }

    function test_executeOp_appliesTrustedSender() public {
        bytes32 newSender = bytes32(uint256(0xFEED));
        vm.prank(OWNER);
        uint256 id = fpm.requestSetTrustedRootSender(newSender);
        vm.warp(block.timestamp + OP_TIMELOCK);

        vm.expectEmit(false, false, false, true, address(fpm));
        emit FraudProverModule.TrustedRootSenderUpdated(TRUSTED_SENDER, newSender);
        vm.prank(OWNER);
        fpm.executeOp(id);

        assertEq(fpm.trustedRootSender(), newSender);
    }

    function test_executeOp_revertsOnInvalidId() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(FraudProverModule.FraudProver_InvalidOpId.selector, 9999)
        );
        fpm.executeOp(9999);
    }

    function test_executeOp_revertsOnDoubleExecute() public {
        vm.prank(OWNER);
        uint256 id = fpm.requestSetTrustedRootSender(bytes32(uint256(0xFEED)));
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        fpm.executeOp(id);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(FraudProverModule.FraudProver_OpAlreadyExecuted.selector, id)
        );
        fpm.executeOp(id);
    }

    function test_cancelOp_blocksExecute() public {
        vm.prank(OWNER);
        uint256 id = fpm.requestSetTrustedRootSender(bytes32(uint256(0xFEED)));
        vm.prank(OWNER);
        fpm.cancelOp(id);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(FraudProverModule.FraudProver_OpAlreadyCancelled.selector, id)
        );
        fpm.executeOp(id);
    }

    function test_cancelOp_revertsAfterExecute() public {
        vm.prank(OWNER);
        uint256 id = fpm.requestSetTrustedRootSender(bytes32(uint256(0xFEED)));
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        fpm.executeOp(id);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(FraudProverModule.FraudProver_OpAlreadyExecuted.selector, id)
        );
        fpm.cancelOp(id);
    }

    /* -------------------------------------------------------------------- */
    /*                              OWNERSHIP                               */
    /* -------------------------------------------------------------------- */

    function test_transferOwnership_isTwoStep() public {
        address NEW_OWNER = address(0xCAFE);
        vm.prank(OWNER);
        fpm.transferOwnership(NEW_OWNER);
        assertEq(fpm.owner(), OWNER);
        vm.prank(NEW_OWNER);
        fpm.acceptOwnership();
        assertEq(fpm.owner(), NEW_OWNER);
    }
}
