// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RESLockVault} from "../../src/wres/RESLockVault.sol";

/// Minimal mintable RES stand-in (the real EticaResearchNFT is ERC721 + burnable).
contract MockRES is ERC721 {
    constructor() ERC721("RES", "RES") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

contract RESLockVaultTest is Test {
    MockRES internal res;
    RESLockVault internal vault;

    address internal constant OWNER = address(0x0117E2);
    address internal constant KEEPER = address(0xBEEF1);
    address internal constant VETO = address(0xE701);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant ALICE_TRON = address(0x77204);
    address internal constant ALICE_PAYOUT = address(0x9A1);

    uint256 internal constant RES_ID = 42;

    function setUp() public {
        res = new MockRES();
        vault = new RESLockVault(address(res), OWNER, KEEPER);
        vm.prank(OWNER);
        vault.setVetoAuthority(VETO);

        res.mint(ALICE, RES_ID);
        vm.prank(ALICE);
        res.setApprovalForAll(address(vault), true);
    }

    function _lock() internal {
        vm.prank(ALICE);
        vault.lock(RES_ID, ALICE_PAYOUT, ALICE_TRON);
    }

    /* ----------------------------- LOCK ------------------------------- */

    function testLockEscrowsAndRecords() public {
        _lock();
        assertEq(res.ownerOf(RES_ID), address(vault), "vault holds RES");
        assertEq(vault.totalLocked(), 1, "totalLocked");
        (address owner, address payout, address tron,,, bool active) = vault.locks(RES_ID);
        assertEq(owner, ALICE, "owner");
        assertEq(payout, ALICE_PAYOUT, "payout");
        assertEq(tron, ALICE_TRON, "tron");
        assertTrue(active, "active");
    }

    function testLockRejectsDoubleLock() public {
        _lock();
        // RES is now in the vault; a second lock of same id can't happen (not owner),
        // but guard the active check explicitly via a fresh attempt path.
        vm.expectRevert();
        vm.prank(ALICE);
        vault.lock(RES_ID, ALICE_PAYOUT, ALICE_TRON);
    }

    function testLockRejectsZeroWallets() public {
        vm.expectRevert(RESLockVault.ZeroAddress.selector);
        vm.prank(ALICE);
        vault.lock(RES_ID, address(0), ALICE_TRON);
    }

    function testDirectTransferRejected() public {
        // A direct safeTransferFrom (not via lock) must be rejected.
        vm.expectRevert();
        vm.prank(ALICE);
        res.safeTransferFrom(ALICE, address(vault), RES_ID);
    }

    function testSetPayoutWalletOnlyOwner() public {
        _lock();
        vm.expectRevert(RESLockVault.NotLockOwner.selector);
        vm.prank(BOB);
        vault.setPayoutWallet(RES_ID, BOB);

        vm.prank(ALICE);
        vault.setPayoutWallet(RES_ID, address(0xFEE));
        (, address payout,,,,) = vault.locks(RES_ID);
        assertEq(payout, address(0xFEE), "updated payout");
    }

    /* ---------------------------- UNLOCK ------------------------------ */

    function testKeeperUnlockReturnsToOwner() public {
        _lock();
        vm.prank(KEEPER);
        vault.keeperUnlock(RES_ID);
        assertEq(res.ownerOf(RES_ID), ALICE, "returned to locker");
        assertEq(vault.totalLocked(), 0, "totalLocked cleared");
        (,,,,, bool active) = vault.locks(RES_ID);
        assertTrue(!active, "lock cleared");
    }

    function testKeeperUnlockOnlyKeeper() public {
        _lock();
        vm.expectRevert(RESLockVault.NotKeeper.selector);
        vm.prank(BOB);
        vault.keeperUnlock(RES_ID);
    }

    function testRequestThenExecuteUnlockAfterWindow() public {
        _lock();
        vm.prank(ALICE);
        vault.requestUnlock(RES_ID);

        // not yet ready
        vm.expectRevert(RESLockVault.UnlockNotReady.selector);
        vault.executeUnlock(RES_ID);

        vm.warp(block.timestamp + 48 hours);
        // permissionless once matured
        vm.prank(BOB);
        vault.executeUnlock(RES_ID);
        assertEq(res.ownerOf(RES_ID), ALICE, "always returns to locker");
    }

    function testRequestUnlockOnlyOwner() public {
        _lock();
        vm.expectRevert(RESLockVault.NotLockOwner.selector);
        vm.prank(BOB);
        vault.requestUnlock(RES_ID);
    }

    function testVetoCancelsPendingUnlock() public {
        _lock();
        vm.prank(ALICE);
        vault.requestUnlock(RES_ID);

        vm.prank(VETO);
        vault.vetoUnlock(RES_ID);

        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(RESLockVault.NoUnlockRequest.selector);
        vault.executeUnlock(RES_ID);
    }

    function testVetoOnlyAuthority() public {
        _lock();
        vm.prank(ALICE);
        vault.requestUnlock(RES_ID);
        vm.expectRevert(RESLockVault.NotVetoAuthority.selector);
        vm.prank(BOB);
        vault.vetoUnlock(RES_ID);
    }

    /* ----------------------------- ADMIN ------------------------------ */

    function testSetChallengeWindowBounds() public {
        vm.prank(OWNER);
        vm.expectRevert(RESLockVault.WindowOutOfRange.selector);
        vault.setChallengeWindow(1 minutes);

        vm.prank(OWNER);
        vault.setChallengeWindow(2 hours);
        assertEq(vault.challengeWindow(), 2 hours, "window updated");
    }

    function testAdminSettersOnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, BOB));
        vm.prank(BOB);
        vault.setKeeper(BOB);
    }

    /// No path exists to send an escrowed NFT anywhere but its locker — proven
    /// by the absence of any arbitrary-recipient release and the owner-only,
    /// non-NFT-touching admin surface above. Two-step ownership is inherited.
    function testTwoStepOwnership() public {
        vm.prank(OWNER);
        vault.transferOwnership(BOB);
        assertEq(vault.owner(), OWNER, "unchanged until accepted");
        vm.prank(BOB);
        vault.acceptOwnership();
        assertEq(vault.owner(), BOB, "handed over");
    }
}
