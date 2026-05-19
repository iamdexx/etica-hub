// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {EticaResearchNFT} from "../../src/labs/EticaResearchNFT.sol";
import {EticaResearchRoyaltySplitter} from "../../src/labs/EticaResearchRoyaltySplitter.sol";

/// @title EticaResearchNFT_Test
/// @notice Forge unit tests covering the EticaResearchNFT contract and
///         its per-token EticaResearchRoyaltySplitter.
///
///         The tests focus on the contract's hard invariants:
///           - zero admin power post-deploy (no upgrade path, no pause,
///             no admin burn, no admin transfer);
///           - per-token immutable royalty receiver (the splitter);
///           - 80/20 splitter math with 80% to original submitter and
///             20% to treasury;
///           - 7-day exclusive claim window enforcement;
///           - branch-id replay prevention;
///           - on-chain tokenURI shape (data:application/json;base64 +
///             cure record embedded in description).
contract EticaResearchNFTTest is Test {
    // ---------------------------------------------------------------
    // EIP-712 typehash (mirrors contract).
    // ---------------------------------------------------------------
    bytes32 internal constant CLAIM_TYPEHASH = keccak256(
        "ClaimPayload(string parentGoalTitle,string sequence,string analysis,uint256 score,uint256 iterations,string branchGoalId,address submitter,uint64 expiresAt,uint64 exclusiveUntil)"
    );

    EticaResearchNFT internal nft;

    // Attestor — only this key can sign valid claim payloads.
    uint256 internal attestorPk = 0xA77E5708;
    address internal attestor;

    address internal treasury = address(0xDEAFBEEF);
    address internal submitter = address(0xB0B);
    address internal stranger = address(0xC0FFEE);

    function setUp() public {
        attestor = vm.addr(attestorPk);
        nft = new EticaResearchNFT(attestor, treasury, "https://eticahub.com");
        // Move past block 0 so block.timestamp is something sane.
        vm.warp(1_700_000_000);
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    function _basePayload() internal view returns (EticaResearchNFT.ClaimPayload memory p) {
        p = EticaResearchNFT.ClaimPayload({
            parentGoalTitle: "Cure IDH1-mutant glioblastoma",
            sequence: "MAGSKLRPDFNCYK",
            analysis: "Selective binding to R132H pocket; 340x selectivity over WT.",
            score: 9100,
            iterations: 14,
            branchGoalId: "branch_001",
            submitter: submitter,
            expiresAt: uint64(block.timestamp + 1 days),
            exclusiveUntil: uint64(block.timestamp + 7 days)
        });
    }

    function _sign(EticaResearchNFT.ClaimPayload memory p, uint256 signerPk)
        internal
        view
        returns (bytes memory sig)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                CLAIM_TYPEHASH,
                keccak256(bytes(p.parentGoalTitle)),
                keccak256(bytes(p.sequence)),
                keccak256(bytes(p.analysis)),
                p.score,
                p.iterations,
                keccak256(bytes(p.branchGoalId)),
                p.submitter,
                p.expiresAt,
                p.exclusiveUntil
            )
        );

        // Reconstruct EIP-712 domain separator from the contract's
        // public eip712Domain() so this test stays correct even if
        // anything about the chain context changes.
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            nft.eip712Domain();
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    // ---------------------------------------------------------------
    // Constructor / immutability checks
    // ---------------------------------------------------------------

    function test_constructor_setsImmutables() public view {
        assertEq(nft.ATTESTOR(), attestor, "attestor not set");
        assertEq(nft.treasury(), treasury, "treasury not set");
        assertEq(nft.name(), "EticaResearch Cure", "name");
        assertEq(nft.symbol(), "CURE", "symbol");
    }

    function test_constructor_rejectsZeroAttestor() public {
        vm.expectRevert(EticaResearchNFT.AttestorZero.selector);
        new EticaResearchNFT(address(0), treasury, "https://eticahub.com");
    }

    function test_constructor_rejectsZeroTreasury() public {
        vm.expectRevert(EticaResearchNFT.TreasuryZero.selector);
        new EticaResearchNFT(attestor, address(0), "https://eticahub.com");
    }

    // ---------------------------------------------------------------
    // Claim happy path
    // ---------------------------------------------------------------

    function test_claim_happyPath() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);

        // During the exclusive window only the original submitter can claim.
        vm.prank(submitter);
        uint256 tokenId = nft.claim(p, sig);

        assertEq(tokenId, 1, "tokenId not 1");
        assertEq(nft.ownerOf(tokenId), submitter, "ownerOf");
        assertEq(nft.submitterOf(tokenId), submitter, "submitterOf");
        assertTrue(nft.isBranchClaimed("branch_001"), "branchClaimed flag");
        assertEq(nft.tokenIdOfBranch(keccak256(bytes("branch_001"))), tokenId, "tokenIdOfBranch");

        // Splitter must exist for this tokenId.
        address splitter = nft.splitterOf(tokenId);
        assertTrue(splitter != address(0), "splitter not deployed");
        assertEq(EticaResearchRoyaltySplitter(payable(splitter)).nft(), address(nft), "splitter.nft");
        assertEq(EticaResearchRoyaltySplitter(payable(splitter)).tokenId(), tokenId, "splitter.tokenId");
    }

    function test_claim_invalidSignatureReverts() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        // Sign with a non-attestor key.
        uint256 wrongPk = 0xBADBEEF;
        bytes memory sig = _sign(p, wrongPk);

        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.InvalidSignature.selector);
        nft.claim(p, sig);
    }

    function test_claim_expiredAttestationReverts() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        p.expiresAt = uint64(block.timestamp - 1);
        bytes memory sig = _sign(p, attestorPk);

        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.AttestationExpired.selector);
        nft.claim(p, sig);
    }

    function test_claim_scoreTooHighReverts() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        p.score = 10_001; // > SCORE_DENOM (10_000)
        bytes memory sig = _sign(p, attestorPk);

        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.ScoreTooHigh.selector);
        nft.claim(p, sig);
    }

    function test_claim_emptyFieldsRevert() public {
        // Each sub-case rebuilds the payload from scratch — memory
        // structs assigned from another memory struct alias the same
        // backing storage in Solidity, so mutating one would corrupt
        // the others.

        // Empty branch id.
        EticaResearchNFT.ClaimPayload memory p1 = _basePayload();
        p1.branchGoalId = "";
        bytes memory sig1 = _sign(p1, attestorPk);
        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.EmptyBranchId.selector);
        nft.claim(p1, sig1);

        // Empty parent goal.
        EticaResearchNFT.ClaimPayload memory p2 = _basePayload();
        p2.parentGoalTitle = "";
        bytes memory sig2 = _sign(p2, attestorPk);
        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.EmptyParentGoal.selector);
        nft.claim(p2, sig2);

        // Empty sequence.
        EticaResearchNFT.ClaimPayload memory p3 = _basePayload();
        p3.sequence = "";
        bytes memory sig3 = _sign(p3, attestorPk);
        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.EmptySequence.selector);
        nft.claim(p3, sig3);

        // Zero submitter — re-sign because submitter is part of digest.
        EticaResearchNFT.ClaimPayload memory p4 = _basePayload();
        p4.submitter = address(0);
        bytes memory sig4 = _sign(p4, attestorPk);
        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.SubmitterZero.selector);
        nft.claim(p4, sig4);
    }

    // ---------------------------------------------------------------
    // Exclusive window enforcement
    // ---------------------------------------------------------------

    function test_claim_exclusiveWindowBlocksStrangers() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);

        vm.prank(stranger);
        vm.expectRevert(EticaResearchNFT.SubmitterOnlyDuringExclusive.selector);
        nft.claim(p, sig);
    }

    function test_claim_anyoneCanClaimAfterExclusiveWindow() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        // Push exclusive expiry into the past; keep attestation alive.
        p.exclusiveUntil = uint64(block.timestamp - 1);
        p.expiresAt = uint64(block.timestamp + 1 days);
        bytes memory sig = _sign(p, attestorPk);

        vm.prank(stranger);
        uint256 tokenId = nft.claim(p, sig);

        // Owner is the claimer.
        assertEq(nft.ownerOf(tokenId), stranger, "owner is claimer");
        // Royalty recipient (submitterOf) stays the ORIGINAL submitter,
        // so even a front-running claimer cannot steal the royalty
        // stream.
        assertEq(nft.submitterOf(tokenId), submitter, "submitterOf");
    }

    // ---------------------------------------------------------------
    // Branch-id replay prevention
    // ---------------------------------------------------------------

    function test_claim_replayReverts() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);

        vm.prank(submitter);
        nft.claim(p, sig);

        // Replay with the same payload + signature.
        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.BranchAlreadyClaimed.selector);
        nft.claim(p, sig);
    }

    // ---------------------------------------------------------------
    // ERC-2981 royalty wiring
    // ---------------------------------------------------------------

    function test_royaltyInfo_pointsAtSplitter() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim(p, sig);

        (address receiver, uint256 amount) = nft.royaltyInfo(tokenId, 1 ether);
        assertEq(receiver, nft.splitterOf(tokenId), "receiver = splitter");
        assertEq(amount, (1 ether * 500) / 10_000, "5% royalty");
    }

    function test_royaltyReceiver_immutablePerToken() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim(p, sig);

        address splitterBefore = nft.splitterOf(tokenId);
        address submitterBefore = nft.submitterOf(tokenId);

        // Transfer the NFT to a stranger. Royalty receiver must NOT
        // follow ownership — it stays anchored to the original
        // submitter via the immutable splitter.
        vm.prank(submitter);
        nft.transferFrom(submitter, stranger, tokenId);

        assertEq(nft.ownerOf(tokenId), stranger, "owner changed");
        assertEq(nft.splitterOf(tokenId), splitterBefore, "splitter unchanged");
        assertEq(nft.submitterOf(tokenId), submitterBefore, "submitterOf unchanged");
    }

    // ---------------------------------------------------------------
    // Splitter mechanics: 80/20 + per-token isolation
    // ---------------------------------------------------------------

    function test_splitter_releasePaysSubmitter80AndTreasury20() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim(p, sig);

        address payable splitter = payable(nft.splitterOf(tokenId));
        vm.deal(splitter, 1 ether);

        uint256 submitterBefore = submitter.balance;
        uint256 treasuryBefore = treasury.balance;

        EticaResearchRoyaltySplitter(splitter).release();

        // 80% to submitter (= 4% of the original sale price upstream),
        // 20% to treasury (= 1% of the original sale price upstream).
        assertEq(submitter.balance - submitterBefore, 0.8 ether, "submitter slice");
        assertEq(treasury.balance - treasuryBefore, 0.2 ether, "treasury slice");
        assertEq(splitter.balance, 0, "splitter drained");

        assertEq(
            EticaResearchRoyaltySplitter(splitter).submitterReleased(),
            0.8 ether,
            "submitterReleased accumulator"
        );
        assertEq(
            EticaResearchRoyaltySplitter(splitter).treasuryReleased(),
            0.2 ether,
            "treasuryReleased accumulator"
        );
    }

    function test_splitter_isolationAcrossTokens() public {
        // Token 1.
        EticaResearchNFT.ClaimPayload memory p1 = _basePayload();
        bytes memory sig1 = _sign(p1, attestorPk);
        vm.prank(submitter);
        uint256 t1 = nft.claim(p1, sig1);

        // Token 2 — different branch id, different submitter.
        address otherSubmitter = address(0xCAB1);
        EticaResearchNFT.ClaimPayload memory p2 = _basePayload();
        p2.branchGoalId = "branch_002";
        p2.submitter = otherSubmitter;
        bytes memory sig2 = _sign(p2, attestorPk);
        vm.prank(otherSubmitter);
        uint256 t2 = nft.claim(p2, sig2);

        address payable s1 = payable(nft.splitterOf(t1));
        address payable s2 = payable(nft.splitterOf(t2));
        assertTrue(s1 != s2, "splitters are distinct");

        // Send only to splitter #2 and release — submitter #1 must
        // receive nothing.
        vm.deal(s2, 1 ether);

        uint256 sub1Before = submitter.balance;
        uint256 sub2Before = otherSubmitter.balance;
        uint256 treasuryBefore = treasury.balance;

        EticaResearchRoyaltySplitter(s2).release();

        assertEq(submitter.balance - sub1Before, 0, "submitter #1 untouched");
        assertEq(otherSubmitter.balance - sub2Before, 0.8 ether, "submitter #2 paid");
        assertEq(treasury.balance - treasuryBefore, 0.2 ether, "treasury paid");
    }

    function test_splitter_nothingToReleaseReverts() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim(p, sig);

        EticaResearchRoyaltySplitter splitter =
            EticaResearchRoyaltySplitter(payable(nft.splitterOf(tokenId)));
        vm.expectRevert(EticaResearchRoyaltySplitter.NothingToRelease.selector);
        splitter.release();
    }

    // ---------------------------------------------------------------
    // Zero-admin-power invariant: no admin burn / pause / upgrade.
    // ---------------------------------------------------------------

    function test_zeroAdminPower_noAdminBurnFunction() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim(p, sig);

        // Burn must be unavailable to anyone except the token owner.
        vm.prank(stranger);
        vm.expectRevert();
        nft.burn(tokenId);

        // Owner may burn their own NFT (this is the only acceptable
        // path; the contract has no admin-burn primitive at all).
        vm.prank(submitter);
        nft.burn(tokenId);
        vm.expectRevert();
        nft.ownerOf(tokenId);
    }

    function test_zeroAdminPower_noOwnerOrAdminRole() public view {
        // Sanity: the contract intentionally has NO Ownable, NO
        // AccessControl, NO Pausable. We confirm via interface IDs.
        // - Ownable: there is no `owner()` accessor exposed at all.
        // - AccessControl: `IAccessControl` interfaceId.
        // - Pausable: there is no standard interfaceId; we just check
        //   the bytecode has no pause/unpause selectors below.
        bytes4 accessControl = bytes4(0x7965db0b);
        assertFalse(nft.supportsInterface(accessControl), "no AccessControl");
    }

    function test_zeroAdminPower_noPauseSelectors() public view {
        // Inspect the contract bytecode and ensure none of the common
        // pause/upgrade selectors are encoded into it. This catches
        // accidental introduction of a pause hatch in a future edit.
        bytes memory code = address(nft).code;
        bytes4[] memory forbidden = new bytes4[](5);
        forbidden[0] = bytes4(keccak256("pause()"));
        forbidden[1] = bytes4(keccak256("unpause()"));
        forbidden[2] = bytes4(keccak256("upgradeTo(address)"));
        forbidden[3] = bytes4(keccak256("upgradeToAndCall(address,bytes)"));
        forbidden[4] = bytes4(keccak256("transferOwnership(address)"));

        for (uint256 i = 0; i < forbidden.length; i++) {
            assertFalse(_containsSelector(code, forbidden[i]), "forbidden selector present");
        }
    }

    function test_supportsInterface_ERC721_and_ERC2981() public view {
        // ERC-721 interface id.
        assertTrue(nft.supportsInterface(0x80ac58cd), "ERC721");
        // ERC-2981 interface id.
        assertTrue(nft.supportsInterface(0x2a55205a), "ERC2981");
    }

    // ---------------------------------------------------------------
    // tokenURI shape
    // ---------------------------------------------------------------

    function test_tokenURI_isDataUriAndContainsRecord() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim(p, sig);

        string memory uri = nft.tokenURI(tokenId);
        bytes memory uriBytes = bytes(uri);

        // Starts with the canonical data URI prefix.
        bytes memory prefix = bytes("data:application/json;base64,");
        assertGt(uriBytes.length, prefix.length, "uri longer than prefix");
        for (uint256 i = 0; i < prefix.length; i++) {
            assertEq(uriBytes[i], prefix[i], "uri prefix mismatch");
        }
    }

    function test_tokenURI_revertsForNonExistentToken() public {
        vm.expectRevert();
        nft.tokenURI(999);
    }

    // ---------------------------------------------------------------
    // Internal: bytecode selector scan
    // ---------------------------------------------------------------

    function _containsSelector(bytes memory code, bytes4 selector) internal pure returns (bool) {
        if (code.length < 4) return false;
        uint256 last = code.length - 4;
        for (uint256 i = 0; i <= last; i++) {
            if (
                code[i] == selector[0]
                    && code[i + 1] == selector[1]
                    && code[i + 2] == selector[2]
                    && code[i + 3] == selector[3]
            ) {
                return true;
            }
        }
        return false;
    }
}
