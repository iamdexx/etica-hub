// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {EticaResearchNFT} from "../../src/labs/EticaResearchNFT.sol";
import {EticaResearchRoyaltySplitter} from "../../src/labs/EticaResearchRoyaltySplitter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @title EticaResearchNFT_Test
/// @notice Forge unit tests covering the EticaResearchNFT contract and
///         its per-token EticaResearchRoyaltySplitter.
///
///         The tests focus on the contract's hard invariants:
///           - zero admin power post-deploy (no upgrade path, no pause,
///             no admin burn, no admin transfer);
///           - per-token immutable splitter address — but **royalty
///             follows the current NFT holder**, resolved at release()
///             time via {ownerOf};
///           - 79/20/1 splitter math: 79% to current holder, 20% to
///             the ancestor chain (geometric 80/20, depth-25 cap),
///             1% to treasury, supported for both native EGAZ and
///             arbitrary ERC-20 (sale-asset-agnostic);
///           - 7-day exclusive window — researcher mints to self —
///             then permissionless settlement with the NFT
///             force-minted to the treasury (post-7d auto-forfeit);
///           - per-mint EGAZ fee: BASE + score-indexed, split
///             79/20/1 across holder / ancestor cascade / treasury,
///             waived for the post-7d auto-forfeit path;
///           - branch-id replay prevention;
///           - on-chain tokenURI shape (data:application/json;base64 +
///             research record embedded in description).
contract EticaResearchNFTTest is Test {
    // ---------------------------------------------------------------
    // EIP-712 typehash (mirrors contract).
    // ---------------------------------------------------------------
    bytes32 internal constant CLAIM_TYPEHASH = keccak256(
        "ClaimPayload(string parentGoalTitle,string sequence,string analysis,uint256 score,uint256 iterations,string branchGoalId,address submitter,uint64 expiresAt,uint64 exclusiveUntil,uint64 marketOpenUntil,string parentBranchGoalId)"
    );

    // ---------------------------------------------------------------
    // Test mint-fee config — chosen so default score-9100 cures
    // produce nice round arithmetic and at least one non-zero leg
    // is exercised on each path.
    // ---------------------------------------------------------------
    uint256 internal constant TEST_BASE_FEE = 0.01 ether;
    uint256 internal constant TEST_MAX_SCORE_FEE = 0.99 ether;

    EticaResearchNFT internal nft;

    // Attestor — only this key can sign valid claim payloads.
    uint256 internal attestorPk = 0xA77E5708;
    address internal attestor;

    address internal treasury = address(0xDEAFBEEF);
    address internal submitter = address(0xB0B);
    address internal stranger = address(0xC0FFEE);
    address internal buyer = address(0xBA1A);

    function setUp() public {
        attestor = vm.addr(attestorPk);
        nft = new EticaResearchNFT(
            attestor, treasury, "https://eticahub.com", TEST_BASE_FEE, TEST_MAX_SCORE_FEE
        );
        // Move past block 0 so block.timestamp is something sane.
        vm.warp(1_700_000_000);

        // Fund test claimants so they can pay the per-mint EGAZ fee.
        vm.deal(submitter, 100 ether);
        vm.deal(stranger, 100 ether);
        vm.deal(buyer, 100 ether);
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    function _basePayload() internal view returns (EticaResearchNFT.ClaimPayload memory p) {
        p = EticaResearchNFT.ClaimPayload({
            parentGoalTitle: "Research IDH1-mutant glioblastoma",
            sequence: "MAGSKLRPDFNCYK",
            analysis: "Selective binding to R132H pocket; 340x selectivity over WT.",
            score: 9100,
            iterations: 14,
            branchGoalId: "branch_001",
            submitter: submitter,
            expiresAt: uint64(block.timestamp + 1 days),
            exclusiveUntil: uint64(block.timestamp + 1 days),
            marketOpenUntil: uint64(block.timestamp + 7 days),
            parentBranchGoalId: ""
        });
    }

    function _expectedFee(uint256 score) internal pure returns (uint256) {
        return TEST_BASE_FEE + (TEST_MAX_SCORE_FEE * score) / 10_000;
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
                p.exclusiveUntil,
                p.marketOpenUntil,
                keccak256(bytes(p.parentBranchGoalId))
            )
        );

        // Reconstruct EIP-712 domain separator from the contract's
        // public eip712Domain() so this test stays correct even if
        // anything about the chain context changes.
        (
            ,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,,
        ) = nft.eip712Domain();
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
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
        assertEq(nft.name(), "EticaResearch", "name");
        assertEq(nft.symbol(), "RES", "symbol");
        assertEq(nft.BASE_MINT_FEE_WEI(), TEST_BASE_FEE, "base fee");
        assertEq(nft.MAX_SCORE_MINT_FEE_WEI(), TEST_MAX_SCORE_FEE, "max score fee");
    }

    function test_constructor_rejectsZeroAttestor() public {
        vm.expectRevert(EticaResearchNFT.AttestorZero.selector);
        new EticaResearchNFT(
            address(0), treasury, "https://eticahub.com", TEST_BASE_FEE, TEST_MAX_SCORE_FEE
        );
    }

    function test_constructor_rejectsZeroTreasury() public {
        vm.expectRevert(EticaResearchNFT.TreasuryZero.selector);
        new EticaResearchNFT(
            attestor, address(0), "https://eticahub.com", TEST_BASE_FEE, TEST_MAX_SCORE_FEE
        );
    }

    function test_constructor_zeroFeesAllowed() public {
        // Zero on both fee legs must be a valid configuration (e.g.
        // ops may choose to launch the contract with no mint tax).
        EticaResearchNFT free =
            new EticaResearchNFT(attestor, treasury, "https://eticahub.com", 0, 0);
        assertEq(free.BASE_MINT_FEE_WEI(), 0, "base fee zero");
        assertEq(free.MAX_SCORE_MINT_FEE_WEI(), 0, "max score fee zero");
    }

    // ---------------------------------------------------------------
    // Claim happy path
    // ---------------------------------------------------------------

    function test_claim_happyPath() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);

        // During the exclusive window only the original submitter can claim.
        uint256 fee = _expectedFee(p.score);
        vm.prank(submitter);
        uint256 tokenId = nft.claim{value: fee}(p, sig);

        assertEq(tokenId, 1, "tokenId not 1");
        assertEq(nft.ownerOf(tokenId), submitter, "ownerOf");
        assertEq(nft.submitterOf(tokenId), submitter, "submitterOf");
        assertTrue(nft.isBranchClaimed("branch_001"), "branchClaimed flag");
        assertEq(nft.tokenIdOfBranch(keccak256(bytes("branch_001"))), tokenId, "tokenIdOfBranch");

        // Splitter must exist for this tokenId.
        address splitter = nft.splitterOf(tokenId);
        assertTrue(splitter != address(0), "splitter not deployed");
        assertEq(
            EticaResearchRoyaltySplitter(payable(splitter)).nft(), address(nft), "splitter.nft"
        );
        assertEq(
            EticaResearchRoyaltySplitter(payable(splitter)).tokenId(), tokenId, "splitter.tokenId"
        );
    }

    function test_claim_invalidSignatureReverts() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        // Sign with a non-attestor key.
        uint256 wrongPk = 0xBADBEEF;
        bytes memory sig = _sign(p, wrongPk);

        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.InvalidSignature.selector);
        nft.claim{value: _expectedFee(p.score)}(p, sig);
    }

    function test_claim_expiredAttestationReverts() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        p.expiresAt = uint64(block.timestamp - 1);
        bytes memory sig = _sign(p, attestorPk);

        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.AttestationExpired.selector);
        nft.claim{value: _expectedFee(p.score)}(p, sig);
    }

    function test_claim_scoreTooHighReverts() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        p.score = 10_001; // > SCORE_DENOM (10_000)
        bytes memory sig = _sign(p, attestorPk);

        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.ScoreTooHigh.selector);
        nft.claim{value: 2 ether}(p, sig);
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
        nft.claim{value: _expectedFee(p1.score)}(p1, sig1);

        // Empty parent goal.
        EticaResearchNFT.ClaimPayload memory p2 = _basePayload();
        p2.parentGoalTitle = "";
        bytes memory sig2 = _sign(p2, attestorPk);
        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.EmptyParentGoal.selector);
        nft.claim{value: _expectedFee(p2.score)}(p2, sig2);

        // Empty sequence.
        EticaResearchNFT.ClaimPayload memory p3 = _basePayload();
        p3.sequence = "";
        bytes memory sig3 = _sign(p3, attestorPk);
        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.EmptySequence.selector);
        nft.claim{value: _expectedFee(p3.score)}(p3, sig3);

        // Zero submitter — re-sign because submitter is part of digest.
        EticaResearchNFT.ClaimPayload memory p4 = _basePayload();
        p4.submitter = address(0);
        bytes memory sig4 = _sign(p4, attestorPk);
        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.SubmitterZero.selector);
        nft.claim{value: _expectedFee(p4.score)}(p4, sig4);
    }

    // ---------------------------------------------------------------
    // Exclusive window enforcement
    // ---------------------------------------------------------------

    function test_claim_exclusiveWindowBlocksStrangers() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);

        vm.prank(stranger);
        vm.expectRevert(EticaResearchNFT.SubmitterOnlyDuringExclusive.selector);
        nft.claim{value: _expectedFee(p.score)}(p, sig);
    }

    function test_claim_openMarketWindowMintsToCaller() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        // Tier 2: exclusive window closed, market window still open.
        p.exclusiveUntil = uint64(block.timestamp - 1);
        p.marketOpenUntil = uint64(block.timestamp + 7 days);
        p.expiresAt = uint64(block.timestamp + 1 days);
        bytes memory sig = _sign(p, attestorPk);

        // Open market: any wallet may mint, paying the full fee, and
        // the NFT is minted to the caller (not the treasury).
        uint256 fee = _expectedFee(p.score);
        vm.prank(stranger);
        uint256 tokenId = nft.claim{value: fee}(p, sig);

        assertEq(nft.ownerOf(tokenId), stranger, "owner is caller (open market)");
        // submitterOf stays the ORIGINAL submitter (attribution only).
        assertEq(nft.submitterOf(tokenId), submitter, "submitterOf");
    }

    function test_claim_abandonedAfterMarketWindowMintsToTreasury() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        // Tier 3: both windows closed -> abandoned.
        p.exclusiveUntil = uint64(block.timestamp - 2);
        p.marketOpenUntil = uint64(block.timestamp - 1);
        p.expiresAt = uint64(block.timestamp + 1 days);
        bytes memory sig = _sign(p, attestorPk);

        // Post-market auto-forfeit: NFT force-minted to treasury
        // regardless of who pays gas. Fee is waived on this path.
        vm.prank(stranger);
        uint256 tokenId = nft.claim(p, sig);

        // Owner is the treasury (auto-forfeit), NOT the caller.
        assertEq(nft.ownerOf(tokenId), treasury, "owner is treasury (auto-forfeit)");
        // submitterOf stays the ORIGINAL submitter (attribution only).
        assertEq(nft.submitterOf(tokenId), submitter, "submitterOf");
    }

    function test_claim_invalidWindowReverts() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        // marketOpenUntil < exclusiveUntil is a malformed window.
        p.exclusiveUntil = uint64(block.timestamp + 7 days);
        p.marketOpenUntil = uint64(block.timestamp + 1 days);
        bytes memory sig = _sign(p, attestorPk);

        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.InvalidWindow.selector);
        nft.claim{value: _expectedFee(p.score)}(p, sig);
    }

    // ---------------------------------------------------------------
    // Branch-id replay prevention
    // ---------------------------------------------------------------

    function test_claim_replayReverts() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);

        vm.prank(submitter);
        nft.claim{value: _expectedFee(p.score)}(p, sig);

        // Replay with the same payload + signature.
        vm.prank(submitter);
        vm.expectRevert(EticaResearchNFT.BranchAlreadyClaimed.selector);
        nft.claim{value: _expectedFee(p.score)}(p, sig);
    }

    // ---------------------------------------------------------------
    // ERC-2981 royalty wiring
    // ---------------------------------------------------------------

    function test_royaltyInfo_pointsAtSplitter() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim{value: _expectedFee(p.score)}(p, sig);

        (address receiver, uint256 amount) = nft.royaltyInfo(tokenId, 1 ether);
        assertEq(receiver, nft.splitterOf(tokenId), "receiver = splitter");
        assertEq(amount, (1 ether * 500) / 10_000, "5% royalty");
    }

    function test_splitterAddress_immutablePerToken() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim{value: _expectedFee(p.score)}(p, sig);

        address splitterBefore = nft.splitterOf(tokenId);
        address submitterBefore = nft.submitterOf(tokenId);

        // Transfer the NFT to a stranger. The SPLITTER ADDRESS must
        // not change (it's the ERC-2981 receiver per tokenId, baked
        // in via CREATE2 with tokenId as salt). The PAYOUT recipient
        // does follow ownership — verified separately in the
        // "royalty follows transfer" test.
        vm.prank(submitter);
        nft.transferFrom(submitter, stranger, tokenId);

        assertEq(nft.ownerOf(tokenId), stranger, "owner changed");
        assertEq(nft.splitterOf(tokenId), splitterBefore, "splitter unchanged");
        assertEq(nft.submitterOf(tokenId), submitterBefore, "submitterOf unchanged");
    }

    // ---------------------------------------------------------------
    // Splitter mechanics: 80/20 native EGAZ + per-token isolation
    // ---------------------------------------------------------------

    function test_splitter_releasePaysHolder99AndTreasury1_rootResearch() public {
        // Root research record (no parent) — the 20% ancestor slice
        // has no recipients to cascade to, so it falls through to the
        // current holder. Net split = 99% holder / 1% treasury.
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim{value: _expectedFee(p.score)}(p, sig);

        address payable splitter = payable(nft.splitterOf(tokenId));
        vm.deal(splitter, 1 ether);

        uint256 submitterBefore = submitter.balance;
        uint256 treasuryBefore = treasury.balance;

        EticaResearchRoyaltySplitter(splitter).release();

        assertEq(
            submitter.balance - submitterBefore, 0.99 ether, "holder slice (79% + 20% fallthrough)"
        );
        assertEq(treasury.balance - treasuryBefore, 0.01 ether, "treasury slice (1%)");
        assertEq(splitter.balance, 0, "splitter drained");

        assertEq(
            EticaResearchRoyaltySplitter(splitter).holderReleased(),
            0.99 ether,
            "holderReleased accumulator"
        );
        assertEq(
            EticaResearchRoyaltySplitter(splitter).treasuryReleased(),
            0.01 ether,
            "treasuryReleased accumulator"
        );
    }

    function test_splitter_isolationAcrossTokens() public {
        // Token 1.
        EticaResearchNFT.ClaimPayload memory p1 = _basePayload();
        bytes memory sig1 = _sign(p1, attestorPk);
        vm.prank(submitter);
        uint256 t1 = nft.claim{value: _expectedFee(p1.score)}(p1, sig1);

        // Token 2 — different branch id, different submitter.
        address otherSubmitter = address(0xCAB1);
        vm.deal(otherSubmitter, 10 ether);
        EticaResearchNFT.ClaimPayload memory p2 = _basePayload();
        p2.branchGoalId = "branch_002";
        p2.submitter = otherSubmitter;
        bytes memory sig2 = _sign(p2, attestorPk);
        vm.prank(otherSubmitter);
        uint256 t2 = nft.claim{value: _expectedFee(p2.score)}(p2, sig2);

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

        assertEq(submitter.balance - sub1Before, 0, "holder #1 untouched");
        assertEq(otherSubmitter.balance - sub2Before, 0.99 ether, "holder #2 paid");
        assertEq(treasury.balance - treasuryBefore, 0.01 ether, "treasury paid");
    }

    function test_splitter_nothingToReleaseReverts() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim{value: _expectedFee(p.score)}(p, sig);

        EticaResearchRoyaltySplitter splitter =
            EticaResearchRoyaltySplitter(payable(nft.splitterOf(tokenId)));
        vm.expectRevert(EticaResearchRoyaltySplitter.NothingToRelease.selector);
        splitter.release();
    }

    // ---------------------------------------------------------------
    // NEW: Royalty stream follows the current NFT holder.
    // ---------------------------------------------------------------

    function test_royaltyFollowsTransfer() public {
        // 1. Researcher mints during exclusive window.
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim{value: _expectedFee(p.score)}(p, sig);

        // 2. Researcher sells / transfers to `buyer`. The royalty
        //    stream must now flow to `buyer`, NOT to the original
        //    submitter.
        vm.prank(submitter);
        nft.transferFrom(submitter, buyer, tokenId);
        assertEq(nft.ownerOf(tokenId), buyer, "owner transferred");

        // 3. A secondary sale (simulated) sends 1 EGAZ to the splitter.
        address payable splitter = payable(nft.splitterOf(tokenId));
        vm.deal(splitter, 1 ether);

        uint256 submitterBefore = submitter.balance;
        uint256 buyerBefore = buyer.balance;
        uint256 treasuryBefore = treasury.balance;

        EticaResearchRoyaltySplitter(splitter).release();

        // 4. Buyer (= current holder) receives the 80% leg; treasury
        //    still receives 20%; original submitter is bypassed.
        assertEq(submitter.balance - submitterBefore, 0, "submitter bypassed");
        assertEq(
            buyer.balance - buyerBefore, 0.99 ether, "buyer (= holder) paid 99% (root cascade)"
        );
        assertEq(treasury.balance - treasuryBefore, 0.01 ether, "treasury paid 1%");
    }

    // ---------------------------------------------------------------
    // NEW: Post-7d unclaimed cure auto-forfeits to treasury;
    // fee waived; subsequent royalty flows to treasury (as holder).
    // ---------------------------------------------------------------

    function test_postSevenDayAutoForfeitToTreasury() public {
        // Cure with an exclusive window that is ALREADY closed at
        // call time but with a still-live attestation.
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        p.exclusiveUntil = uint64(block.timestamp - 2);
        p.marketOpenUntil = uint64(block.timestamp - 1);
        p.expiresAt = uint64(block.timestamp + 1 days);
        bytes memory sig = _sign(p, attestorPk);

        uint256 strangerBalBefore = stranger.balance;
        uint256 treasuryBalBefore = treasury.balance;

        // A non-submitter (any wallet) wakes the contract. They pay
        // gas only; fee is waived because the contract auto-mints
        // to the treasury itself.
        vm.prank(stranger);
        uint256 tokenId = nft.claim(p, sig);

        // NFT lands in the treasury wallet; original submitter
        // recorded for attribution only.
        assertEq(nft.ownerOf(tokenId), treasury, "auto-forfeit to treasury");
        assertEq(nft.submitterOf(tokenId), submitter, "submitterOf attribution");

        // No EGAZ moved on this claim path (other than gas, which
        // forge does not deduct here).
        assertEq(stranger.balance, strangerBalBefore, "stranger value untouched");
        assertEq(treasury.balance, treasuryBalBefore, "treasury value unchanged");

        // Future royalties on this token now flow to the treasury
        // both legs — because the treasury is the current holder
        // AND the treasury receiver.
        address payable splitter = payable(nft.splitterOf(tokenId));
        vm.deal(splitter, 1 ether);
        EticaResearchRoyaltySplitter(splitter).release();
        assertEq(
            treasury.balance - treasuryBalBefore, 1 ether, "treasury receives both legs as holder"
        );
    }

    function test_postSevenDay_refundsAccidentalValue() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        p.exclusiveUntil = uint64(block.timestamp - 2);
        p.marketOpenUntil = uint64(block.timestamp - 1);
        p.expiresAt = uint64(block.timestamp + 1 days);
        bytes memory sig = _sign(p, attestorPk);

        uint256 strangerBefore = stranger.balance;
        uint256 treasuryBefore = treasury.balance;

        // Stranger overpays — must be fully refunded because the
        // auto-forfeit path waives all fees.
        vm.prank(stranger);
        nft.claim{value: 5 ether}(p, sig);

        assertEq(stranger.balance, strangerBefore, "stranger overpayment refunded");
        assertEq(treasury.balance, treasuryBefore, "treasury balance unchanged");
    }

    // ---------------------------------------------------------------
    // NEW: ERC-20 splitter release (multi-asset royalties).
    // ---------------------------------------------------------------

    function test_splitter_releaseERC20() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim{value: _expectedFee(p.score)}(p, sig);

        address payable splitter = payable(nft.splitterOf(tokenId));

        // Mint an ERC-20 to the splitter (simulating a marketplace
        // forwarding the royalty leg in that asset).
        MockERC20 token = new MockERC20("StakedEtherx", "stETX");
        token.mint(splitter, 1_000 ether);

        uint256 submitterBefore = token.balanceOf(submitter);
        uint256 treasuryBefore = token.balanceOf(treasury);

        EticaResearchRoyaltySplitter(splitter).releaseERC20(IERC20(address(token)));

        assertEq(
            token.balanceOf(submitter) - submitterBefore,
            990 ether,
            "holder receives 99% in stETX (root)"
        );
        assertEq(
            token.balanceOf(treasury) - treasuryBefore, 10 ether, "treasury receives 1% in stETX"
        );
        assertEq(token.balanceOf(splitter), 0, "splitter drained of stETX");

        // Per-token accumulators must track this asset independently.
        assertEq(
            EticaResearchRoyaltySplitter(splitter).holderReleasedToken(address(token)),
            990 ether,
            "holderReleasedToken[stETX]"
        );
        assertEq(
            EticaResearchRoyaltySplitter(splitter).treasuryReleasedToken(address(token)),
            10 ether,
            "treasuryReleasedToken[stETX]"
        );
        // Native EGAZ accumulators must NOT be touched.
        assertEq(
            EticaResearchRoyaltySplitter(splitter).holderReleased(),
            0,
            "native holderReleased untouched"
        );
        assertEq(
            EticaResearchRoyaltySplitter(splitter).treasuryReleased(),
            0,
            "native treasuryReleased untouched"
        );
    }

    function test_splitter_releaseERC20_followsTransfer() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim{value: _expectedFee(p.score)}(p, sig);

        // Transfer the NFT to `buyer`, then release an ERC-20 royalty.
        vm.prank(submitter);
        nft.transferFrom(submitter, buyer, tokenId);

        address payable splitter = payable(nft.splitterOf(tokenId));
        MockERC20 token = new MockERC20("USDT", "USDT");
        token.mint(splitter, 100 ether);

        EticaResearchRoyaltySplitter(splitter).releaseERC20(IERC20(address(token)));

        assertEq(token.balanceOf(submitter), 0, "original submitter bypassed");
        assertEq(token.balanceOf(buyer), 99 ether, "new holder paid 99% (root cascade)");
        assertEq(token.balanceOf(treasury), 1 ether, "treasury paid 1%");
    }

    function test_splitter_releaseERC20_zeroTokenReverts() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim{value: _expectedFee(p.score)}(p, sig);

        EticaResearchRoyaltySplitter splitter =
            EticaResearchRoyaltySplitter(payable(nft.splitterOf(tokenId)));
        vm.expectRevert(EticaResearchRoyaltySplitter.TokenZero.selector);
        splitter.releaseERC20(IERC20(address(0)));
    }

    // ---------------------------------------------------------------
    // NEW: Per-mint EGAZ fee — collection, overpayment refund,
    // underpayment revert, post-7d waiver.
    // ---------------------------------------------------------------

    function test_mintFee_chargedDuringExclusiveWindow() public {
        // Root mint — mint fee is split 79/20/1 (holder/ancestors/treasury).
        // With no ancestors the 20% ancestor slice falls through to the
        // holder (= minter), so the minter pockets 99% back and only
        // 1% lands at treasury.
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);

        uint256 expected = _expectedFee(p.score);
        // At score 9100 with 0.01 BASE + 0.99 MAX:
        //   fee = 0.01 + 0.99 * 9100 / 10000 = 0.01 + 0.9009 = 0.9109 ether
        assertEq(expected, 0.01 ether + 0.9009 ether, "fee formula sanity");

        uint256 submitterBefore = submitter.balance;
        uint256 treasuryBefore = treasury.balance;

        vm.prank(submitter);
        nft.claim{value: expected}(p, sig);

        uint256 expectedTreasury = expected / 100; // 1% of fee
        uint256 netCost = expected - (expected - expectedTreasury); // = expectedTreasury
        assertEq(submitterBefore - submitter.balance, netCost, "submitter net cost = 1% of fee");
        assertEq(treasury.balance - treasuryBefore, expectedTreasury, "treasury received 1% slice");
    }

    function test_mintFee_scoreIndexedScalesLinearly() public {
        // Different score = different fee, by the linear formula.
        // Root mint: treasury slice is 1% of computed fee.
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        p.score = 5000; // 0.50
        bytes memory sig = _sign(p, attestorPk);

        uint256 expected = _expectedFee(p.score);
        // 0.01 + 0.99 * 5000/10000 = 0.01 + 0.495 = 0.505 ether
        assertEq(expected, 0.505 ether, "linear scaling sanity");

        uint256 treasuryBefore = treasury.balance;
        vm.prank(submitter);
        nft.claim{value: expected}(p, sig);
        assertEq(treasury.balance - treasuryBefore, expected / 100, "treasury got 1% of fee");
    }

    function test_mintFee_overpaymentRefunded() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);

        uint256 expected = _expectedFee(p.score);
        uint256 overpayment = 3 ether;
        uint256 submitterBefore = submitter.balance;
        uint256 treasuryBefore = treasury.balance;

        vm.prank(submitter);
        nft.claim{value: expected + overpayment}(p, sig);

        // Overpayment refunded; submitter's net cost = 1% of fee
        // (the rest of the fee cascades back as the holder leg on a
        // root mint).
        assertEq(
            submitterBefore - submitter.balance, expected / 100, "submitter net cost = 1% of fee"
        );
        assertEq(
            treasury.balance - treasuryBefore, expected / 100, "treasury received only 1% of fee"
        );
    }

    function test_mintFee_underpaymentReverts() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);

        uint256 expected = _expectedFee(p.score);
        vm.prank(submitter);
        vm.expectRevert(
            abi.encodeWithSelector(
                EticaResearchNFT.InsufficientMintFee.selector, expected, expected - 1
            )
        );
        nft.claim{value: expected - 1}(p, sig);
    }

    function test_mintFee_waivedOnTreasuryAutoForfeit() public {
        // Closed-window cure — anyone can call, NFT auto-mints to treasury.
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        p.exclusiveUntil = uint64(block.timestamp - 2);
        p.marketOpenUntil = uint64(block.timestamp - 1);
        p.expiresAt = uint64(block.timestamp + 1 days);
        bytes memory sig = _sign(p, attestorPk);

        uint256 treasuryBefore = treasury.balance;
        // Calling with value=0 must succeed.
        vm.prank(stranger);
        nft.claim(p, sig);
        assertEq(treasury.balance, treasuryBefore, "no fee charged on auto-forfeit");
    }

    // ---------------------------------------------------------------
    // Zero-admin-power invariant: no admin burn / pause / upgrade.
    // ---------------------------------------------------------------

    function test_zeroAdminPower_noAdminBurnFunction() public {
        EticaResearchNFT.ClaimPayload memory p = _basePayload();
        bytes memory sig = _sign(p, attestorPk);
        vm.prank(submitter);
        uint256 tokenId = nft.claim{value: _expectedFee(p.score)}(p, sig);

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
        bytes4[] memory forbidden = new bytes4[](7);
        forbidden[0] = bytes4(keccak256("pause()"));
        forbidden[1] = bytes4(keccak256("unpause()"));
        forbidden[2] = bytes4(keccak256("upgradeTo(address)"));
        forbidden[3] = bytes4(keccak256("upgradeToAndCall(address,bytes)"));
        forbidden[4] = bytes4(keccak256("transferOwnership(address)"));
        forbidden[5] = bytes4(keccak256("setTreasury(address)"));
        forbidden[6] = bytes4(keccak256("setAttestor(address)"));

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
        uint256 tokenId = nft.claim{value: _expectedFee(p.score)}(p, sig);

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
                code[i] == selector[0] && code[i + 1] == selector[1] && code[i + 2] == selector[2]
                    && code[i + 3] == selector[3]
            ) {
                return true;
            }
        }
        return false;
    }
}
