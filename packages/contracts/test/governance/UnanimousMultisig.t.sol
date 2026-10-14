// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {UnanimousMultisig} from "../../src/governance/UnanimousMultisig.sol";

contract Target {
    uint256 public x;
    address public lastCaller;

    function set(uint256 v) external {
        x = v;
        lastCaller = msg.sender;
    }

    function fail() external pure {
        revert("nope");
    }
}

contract UnanimousMultisigTest is Test {
    address constant A = address(0xA11CE);
    address constant B = address(0xB0B);
    address constant NOBODY = address(0xBAD);

    UnanimousMultisig sig;
    Target target;

    function setUp() public {
        address[] memory owners = new address[](2);
        owners[0] = A;
        owners[1] = B;
        sig = new UnanimousMultisig(owners);
        target = new Target();
    }

    function test_constructorRejectsBadOwnerSets() public {
        address[] memory one = new address[](1);
        one[0] = A;
        vm.expectRevert(bytes("Multisig: NEED_TWO"));
        new UnanimousMultisig(one);
        address[] memory dup = new address[](2);
        dup[0] = A;
        dup[1] = A;
        vm.expectRevert(bytes("Multisig: DUP_OWNER"));
        new UnanimousMultisig(dup);
    }

    function test_executesOnlyWhenBothConfirm() public {
        bytes memory data = abi.encodeCall(Target.set, (7));
        vm.prank(A);
        uint256 id = sig.propose(address(target), 0, data);
        assertEq(target.x(), 0);
        assertEq(sig.proposal(id).confirmations, 1);

        vm.expectRevert(bytes("Multisig: NOT_OWNER"));
        vm.prank(NOBODY);
        sig.confirm(id);
        vm.expectRevert(bytes("Multisig: ALREADY_CONFIRMED"));
        vm.prank(A);
        sig.confirm(id);

        vm.prank(B);
        sig.confirm(id);
        assertEq(target.x(), 7);
        assertEq(target.lastCaller(), address(sig));
        assertTrue(sig.proposal(id).executed);

        vm.expectRevert(bytes("Multisig: CLOSED"));
        vm.prank(B);
        sig.confirm(id);
    }

    function test_oneNoMeansNoChange_cancelAndRevoke() public {
        bytes memory data = abi.encodeCall(Target.set, (7));
        vm.prank(A);
        uint256 id = sig.propose(address(target), 0, data);
        vm.prank(B);
        sig.cancel(id);
        vm.expectRevert(bytes("Multisig: CLOSED"));
        vm.prank(B);
        sig.confirm(id);
        assertEq(target.x(), 0);

        vm.prank(A);
        id = sig.propose(address(target), 0, data);
        vm.prank(A);
        sig.revoke(id);
        assertEq(sig.proposal(id).confirmations, 0);
        vm.prank(B);
        sig.confirm(id);
        assertEq(target.x(), 0);
        vm.prank(A);
        sig.confirm(id);
        assertEq(target.x(), 7);
    }

    function test_failedCallRevertsAndStaysOpen() public {
        vm.prank(A);
        uint256 id = sig.propose(address(target), 0, abi.encodeCall(Target.fail, ()));
        vm.expectRevert(bytes("Multisig: CALL_FAILED"));
        vm.prank(B);
        sig.confirm(id);
        assertFalse(sig.proposal(id).executed);
    }

    function test_nonOwnerCannotPropose() public {
        vm.expectRevert(bytes("Multisig: NOT_OWNER"));
        vm.prank(NOBODY);
        sig.propose(address(target), 0, "");
    }
}
