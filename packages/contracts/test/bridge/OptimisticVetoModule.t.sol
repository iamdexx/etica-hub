// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {OptimisticVetoModule} from "../../src/bridge/OptimisticVetoModule.sol";
import {BridgeMessage, IBridgeMinter, VetoReason} from "../../src/bridge/IBridgeMinter.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Stub for IBridgeMinter.vetoClaimManual. Records the latest call so
/// tests can assert that veto forwarding actually reached the minter.
contract MockBridgeMinter is IBridgeMinter {
    bytes32 public lastNonce;
    VetoReason public lastReason;
    uint256 public callCount;
    bool public shouldRevert;

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function vetoClaimManual(bytes32 nonce, VetoReason reason) external override {
        if (shouldRevert) revert("minter rejected");
        lastNonce = nonce;
        lastReason = reason;
        callCount += 1;
    }

    function vetoClaimWithProof(bytes32, BridgeMessage calldata, address) external pure override {
        revert("not used in OVM tests");
    }
}

contract OptimisticVetoModuleTest is Test {
    MockBridgeMinter internal minter;
    OptimisticVetoModule internal ovm;

    address internal constant OWNER = address(0x0117E2);
    address internal constant BOT_KEY = address(0xB07);
    address internal constant BACKUP_VETOER = address(0xBACC);
    address internal constant ATTACKER = address(0xBAD);

    uint64 internal constant OP_TIMELOCK = 24 hours;

    bytes32 internal constant NONCE_A = bytes32(uint256(0xA));
    bytes32 internal constant NONCE_B = bytes32(uint256(0xB));

    function setUp() public {
        minter = new MockBridgeMinter();
        ovm = new OptimisticVetoModule(OWNER, IBridgeMinter(address(minter)), OP_TIMELOCK);
    }

    function _promoteBotKey(address key) internal {
        vm.prank(OWNER);
        uint256 id = ovm.requestRotateVetoKey(key);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        ovm.executeOp(id);
    }

    function _authorizeVetoer(address v) internal {
        vm.prank(OWNER);
        uint256 id = ovm.requestAuthorizeVetoer(v);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        ovm.executeOp(id);
    }

    /* -------------------------------------------------------------------- */
    /*                            CONSTRUCTOR                               */
    /* -------------------------------------------------------------------- */

    function test_constructor_setsImmutables() public view {
        assertEq(address(ovm.minter()), address(minter));
        assertEq(ovm.opTimelock(), OP_TIMELOCK);
        assertEq(ovm.owner(), OWNER);
        assertEq(ovm.vetoKey(), address(0));
        assertEq(ovm.opCounter(), 0);
    }

    function test_constructor_revertsOnZeroMinter() public {
        vm.expectRevert(OptimisticVetoModule.OptimisticVeto_ZeroAddress.selector);
        new OptimisticVetoModule(OWNER, IBridgeMinter(address(0)), OP_TIMELOCK);
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new OptimisticVetoModule(address(0), IBridgeMinter(address(minter)), OP_TIMELOCK);
    }

    /* -------------------------------------------------------------------- */
    /*                                VETO                                  */
    /* -------------------------------------------------------------------- */

    function test_veto_revertsBeforeKeySet() public {
        // vetoKey is address(0); even calling from address(0) should not work
        // because we use msg.sender check. Just confirm a normal caller fails.
        vm.prank(BOT_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptimisticVetoModule.OptimisticVeto_UnauthorizedVetoer.selector, BOT_KEY
            )
        );
        ovm.veto(NONCE_A, VetoReason.OPERATOR_MANUAL);
    }

    function test_veto_botKeyForwards() public {
        _promoteBotKey(BOT_KEY);

        vm.expectEmit(true, true, false, true, address(ovm));
        emit OptimisticVetoModule.VetoForwarded(NONCE_A, BOT_KEY, VetoReason.BOT_AMOUNT_MISMATCH);
        vm.prank(BOT_KEY);
        ovm.veto(NONCE_A, VetoReason.BOT_AMOUNT_MISMATCH);

        assertEq(minter.callCount(), 1);
        assertEq(minter.lastNonce(), NONCE_A);
        assertEq(uint8(minter.lastReason()), uint8(VetoReason.BOT_AMOUNT_MISMATCH));
    }

    function test_veto_backupVetoerForwards() public {
        _authorizeVetoer(BACKUP_VETOER);

        vm.prank(BACKUP_VETOER);
        ovm.veto(NONCE_B, VetoReason.OPERATOR_MANUAL);

        assertEq(minter.callCount(), 1);
        assertEq(minter.lastNonce(), NONCE_B);
        assertEq(uint8(minter.lastReason()), uint8(VetoReason.OPERATOR_MANUAL));
    }

    function test_veto_revertsForUnauthorized() public {
        _promoteBotKey(BOT_KEY);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptimisticVetoModule.OptimisticVeto_UnauthorizedVetoer.selector, ATTACKER
            )
        );
        ovm.veto(NONCE_A, VetoReason.OPERATOR_MANUAL);
    }

    function test_veto_revertsAfterDeauthorize() public {
        _authorizeVetoer(BACKUP_VETOER);
        vm.prank(OWNER);
        ovm.deauthorizeVetoer(BACKUP_VETOER);

        vm.prank(BACKUP_VETOER);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptimisticVetoModule.OptimisticVeto_UnauthorizedVetoer.selector, BACKUP_VETOER
            )
        );
        ovm.veto(NONCE_A, VetoReason.OPERATOR_MANUAL);
    }

    function test_veto_bubblesMinterRevert() public {
        _promoteBotKey(BOT_KEY);
        minter.setShouldRevert(true);
        vm.prank(BOT_KEY);
        vm.expectRevert(bytes("minter rejected"));
        ovm.veto(NONCE_A, VetoReason.OPERATOR_MANUAL);
    }

    function test_veto_oldKeyRevertsAfterRotation() public {
        _promoteBotKey(BOT_KEY);
        address newBot = address(0xB0772);
        _promoteBotKey(newBot);

        // Old key is no longer authorized.
        vm.prank(BOT_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptimisticVetoModule.OptimisticVeto_UnauthorizedVetoer.selector, BOT_KEY
            )
        );
        ovm.veto(NONCE_A, VetoReason.OPERATOR_MANUAL);

        // New key works.
        vm.prank(newBot);
        ovm.veto(NONCE_A, VetoReason.OPERATOR_MANUAL);
        assertEq(minter.callCount(), 1);
    }

    /* -------------------------------------------------------------------- */
    /*                       SECURITY-POSITIVE (INSTANT)                    */
    /* -------------------------------------------------------------------- */

    function test_deauthorizeVetoer_onlyOwner() public {
        _authorizeVetoer(BACKUP_VETOER);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        ovm.deauthorizeVetoer(BACKUP_VETOER);
    }

    function test_deauthorizeVetoer_revertsIfNotAuthorized() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptimisticVetoModule.OptimisticVeto_NotAuthorized.selector, BACKUP_VETOER
            )
        );
        ovm.deauthorizeVetoer(BACKUP_VETOER);
    }

    function test_deauthorizeVetoer_emitsEvent() public {
        _authorizeVetoer(BACKUP_VETOER);
        vm.expectEmit(true, false, false, true, address(ovm));
        emit OptimisticVetoModule.VetoerDeauthorized(BACKUP_VETOER);
        vm.prank(OWNER);
        ovm.deauthorizeVetoer(BACKUP_VETOER);
        assertFalse(ovm.authorizedVetoers(BACKUP_VETOER));
    }

    /* -------------------------------------------------------------------- */
    /*                         OWNER TIMELOCKED OPS                         */
    /* -------------------------------------------------------------------- */

    function test_requestRotateVetoKey_onlyOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        ovm.requestRotateVetoKey(BOT_KEY);
    }

    function test_requestRotateVetoKey_revertsOnZero() public {
        vm.prank(OWNER);
        vm.expectRevert(OptimisticVetoModule.OptimisticVeto_ZeroAddress.selector);
        ovm.requestRotateVetoKey(address(0));
    }

    function test_requestAuthorizeVetoer_onlyOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        ovm.requestAuthorizeVetoer(BACKUP_VETOER);
    }

    function test_requestAuthorizeVetoer_revertsOnZero() public {
        vm.prank(OWNER);
        vm.expectRevert(OptimisticVetoModule.OptimisticVeto_ZeroAddress.selector);
        ovm.requestAuthorizeVetoer(address(0));
    }

    function test_requestAuthorizeVetoer_revertsIfAlreadyAuthorized() public {
        _authorizeVetoer(BACKUP_VETOER);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptimisticVetoModule.OptimisticVeto_AlreadyAuthorized.selector, BACKUP_VETOER
            )
        );
        ovm.requestAuthorizeVetoer(BACKUP_VETOER);
    }

    function test_executeOp_revertsBeforeTimelock() public {
        vm.prank(OWNER);
        uint256 id = ovm.requestRotateVetoKey(BOT_KEY);
        uint64 executableAt = uint64(block.timestamp) + OP_TIMELOCK;

        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptimisticVetoModule.OptimisticVeto_OpTimelockNotElapsed.selector,
                executableAt,
                uint64(block.timestamp)
            )
        );
        ovm.executeOp(id);
    }

    function test_executeOp_revertsOnInvalidId() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticVetoModule.OptimisticVeto_InvalidOpId.selector, 9999)
        );
        ovm.executeOp(9999);
    }

    function test_executeOp_revertsOnDoubleExecute() public {
        vm.prank(OWNER);
        uint256 id = ovm.requestRotateVetoKey(BOT_KEY);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        ovm.executeOp(id);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptimisticVetoModule.OptimisticVeto_OpAlreadyExecuted.selector, id
            )
        );
        ovm.executeOp(id);
    }

    function test_cancelOp_blocksExecute() public {
        vm.prank(OWNER);
        uint256 id = ovm.requestRotateVetoKey(BOT_KEY);
        vm.prank(OWNER);
        ovm.cancelOp(id);

        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptimisticVetoModule.OptimisticVeto_OpAlreadyCancelled.selector, id
            )
        );
        ovm.executeOp(id);
    }

    function test_cancelOp_revertsAfterExecute() public {
        vm.prank(OWNER);
        uint256 id = ovm.requestRotateVetoKey(BOT_KEY);
        vm.warp(block.timestamp + OP_TIMELOCK);
        vm.prank(OWNER);
        ovm.executeOp(id);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptimisticVetoModule.OptimisticVeto_OpAlreadyExecuted.selector, id
            )
        );
        ovm.cancelOp(id);
    }

    function test_executeOp_emitsEventsForKeyRotation() public {
        vm.prank(OWNER);
        uint256 id = ovm.requestRotateVetoKey(BOT_KEY);
        vm.warp(block.timestamp + OP_TIMELOCK);

        vm.expectEmit(true, true, false, true, address(ovm));
        emit OptimisticVetoModule.VetoKeyRotated(address(0), BOT_KEY);
        vm.expectEmit(true, true, false, true, address(ovm));
        emit OptimisticVetoModule.OpExecuted(id, OptimisticVetoModule.OpKind.ROTATE_VETO_KEY);
        vm.prank(OWNER);
        ovm.executeOp(id);

        assertEq(ovm.vetoKey(), BOT_KEY);
    }

    function test_executeOp_emitsEventsForVetoerAuth() public {
        vm.prank(OWNER);
        uint256 id = ovm.requestAuthorizeVetoer(BACKUP_VETOER);
        vm.warp(block.timestamp + OP_TIMELOCK);

        vm.expectEmit(true, false, false, true, address(ovm));
        emit OptimisticVetoModule.VetoerAuthorized(BACKUP_VETOER);
        vm.expectEmit(true, true, false, true, address(ovm));
        emit OptimisticVetoModule.OpExecuted(id, OptimisticVetoModule.OpKind.AUTHORIZE_VETOER);
        vm.prank(OWNER);
        ovm.executeOp(id);

        assertTrue(ovm.authorizedVetoers(BACKUP_VETOER));
    }

    function test_opCounter_incrementsAcrossKinds() public {
        vm.startPrank(OWNER);
        uint256 id1 = ovm.requestRotateVetoKey(BOT_KEY);
        uint256 id2 = ovm.requestAuthorizeVetoer(BACKUP_VETOER);
        vm.stopPrank();

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(ovm.opCounter(), 2);
    }

    /* -------------------------------------------------------------------- */
    /*                              OWNERSHIP                               */
    /* -------------------------------------------------------------------- */

    function test_transferOwnership_isTwoStep() public {
        address NEW_OWNER = address(0xDEAD22);
        vm.prank(OWNER);
        ovm.transferOwnership(NEW_OWNER);

        // Pending; OWNER still in charge.
        assertEq(ovm.owner(), OWNER);

        vm.prank(NEW_OWNER);
        ovm.acceptOwnership();
        assertEq(ovm.owner(), NEW_OWNER);
    }
}
