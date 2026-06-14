// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {EticaResearchNFT} from "../../src/labs/EticaResearchNFT.sol";
import {EticaResearchRoyaltySplitter} from "../../src/labs/EticaResearchRoyaltySplitter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Helper that reverts on receive — used to exercise the
///         reverting-ancestor fallthrough path in the splitter.
contract RevertingReceiver {
    receive() external payable {
        revert("nope");
    }
}

/// @title EticaResearchNFTCascade_Test
/// @notice Forge tests covering the 79/20/1 mint + sale split with
///         the geometric ancestor cascade (depth-25 cap).
contract EticaResearchNFTCascadeTest is Test {
    bytes32 internal constant CLAIM_TYPEHASH = keccak256(
        "ClaimPayload(string parentGoalTitle,string sequence,string analysis,uint256 score,uint256 iterations,string branchGoalId,address submitter,uint64 expiresAt,uint64 exclusiveUntil,uint64 marketOpenUntil,string parentBranchGoalId)"
    );

    uint256 internal constant TEST_BASE_FEE = 0.01 ether;
    uint256 internal constant TEST_MAX_SCORE_FEE = 0.99 ether;

    EticaResearchNFT internal nft;

    uint256 internal attestorPk = 0xA77E5708;
    address internal attestor;

    address internal treasury = address(0xDEAFBEEF);

    function setUp() public {
        attestor = vm.addr(attestorPk);
        nft = new EticaResearchNFT(
            attestor, treasury, "https://eticahub.com", TEST_BASE_FEE, TEST_MAX_SCORE_FEE
        );
        vm.warp(1_700_000_000);
    }

    function _payload(string memory branchId, string memory parentId, address submitter_)
        internal
        view
        returns (EticaResearchNFT.ClaimPayload memory p)
    {
        p = EticaResearchNFT.ClaimPayload({
            parentGoalTitle: "Research target X",
            sequence: "MAGSKLRPDFNCYK",
            analysis: "Selective binding analysis.",
            score: 9100,
            iterations: 14,
            branchGoalId: branchId,
            submitter: submitter_,
            expiresAt: uint64(block.timestamp + 1 days),
            exclusiveUntil: uint64(block.timestamp + 1 days),
            marketOpenUntil: uint64(block.timestamp + 7 days),
            parentBranchGoalId: parentId
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
                p.exclusiveUntil,
                p.marketOpenUntil,
                keccak256(bytes(p.parentBranchGoalId))
            )
        );
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

    function _expectedFee(uint256 score) internal pure returns (uint256) {
        return TEST_BASE_FEE + (TEST_MAX_SCORE_FEE * score) / 10_000;
    }

    function _mint(string memory branchId, string memory parentId, address holder)
        internal
        returns (uint256 tokenId)
    {
        vm.deal(holder, 100 ether);
        EticaResearchNFT.ClaimPayload memory p = _payload(branchId, parentId, holder);
        bytes memory sig = _sign(p, attestorPk);
        uint256 fee = _expectedFee(p.score);
        vm.prank(holder);
        tokenId = nft.claim{value: fee}(p, sig);
    }

    // ---------------------------------------------------------------
    // Ancestor chain resolution
    // ---------------------------------------------------------------

    function test_walkAncestors_rootReturnsEmpty() public {
        uint256 t = _mint("root", "", address(0xA1));
        address[] memory ancestors = nft.getAncestorHolders(t);
        assertEq(ancestors.length, 0, "root has no ancestors");
        assertEq(nft.parentTokenIdOf(t), 0, "no parent token");
    }

    function test_walkAncestors_depth3() public {
        address h1 = address(0xA1);
        address h2 = address(0xA2);
        address h3 = address(0xA3);

        uint256 t1 = _mint("g1", "", h1);
        uint256 t2 = _mint("g2", "g1", h2);
        uint256 t3 = _mint("g3", "g2", h3);

        address[] memory ancestors = nft.getAncestorHolders(t3);
        assertEq(ancestors.length, 2, "depth-3 chain has 2 ancestors above");
        assertEq(ancestors[0], h2, "immediate parent");
        assertEq(ancestors[1], h1, "grandparent");

        assertEq(nft.parentTokenIdOf(t3), t2, "parentTokenIdOf");
        assertEq(nft.parentTokenIdOf(t2), t1, "parentTokenIdOf");
        assertEq(nft.parentTokenIdOf(t1), 0, "root has no parent");
    }

    function test_walkAncestors_unmintedParentBreaksChain() public {
        // Mint a node whose parent branch goal id has NEVER been claimed.
        uint256 t = _mint("orphan", "ghost-parent", address(0xA1));
        address[] memory ancestors = nft.getAncestorHolders(t);
        assertEq(ancestors.length, 0, "unminted parent breaks the chain");
    }

    // ---------------------------------------------------------------
    // Sale royalty cascade: depth-3 splits 79/20/1 with geometric 80/20
    // ---------------------------------------------------------------

    function test_release_depth3_cascadeMath() public {
        address h1 = address(0xA1);
        address h2 = address(0xA2);
        address h3 = address(0xA3);

        _mint("g1", "", h1);
        _mint("g2", "g1", h2);
        uint256 t3 = _mint("g3", "g2", h3);

        // Send 10 ether to the depth-3 splitter and release.
        address payable splitter = payable(nft.splitterOf(t3));
        vm.deal(splitter, 10 ether);

        uint256 h1Before = h1.balance;
        uint256 h2Before = h2.balance;
        uint256 h3Before = h3.balance;
        uint256 treasuryBefore = treasury.balance;

        EticaResearchRoyaltySplitter(splitter).release();

        // Math:
        //   treasury = 10 * 100 / 10000 = 0.1
        //   holder   = 10 * 7900/10000 = 7.9
        //   ancestor pool = 10 - 0.1 - 7.9 = 2.0
        //   parent (depth 1) = 2.0 * 0.8 = 1.6
        //   grandparent (depth 2) = 0.4 * 0.8 = 0.32
        //   tail (0.08) falls through to holder => holder = 7.98
        assertEq(treasury.balance - treasuryBefore, 0.1 ether, "treasury slice = 1%");
        assertEq(h2.balance - h2Before, 1.6 ether, "parent receives 80% of ancestor pool");
        assertEq(h1.balance - h1Before, 0.32 ether, "grandparent receives 16% of ancestor pool");
        assertEq(h3.balance - h3Before, 7.98 ether, "holder receives 79% + geo remainder");
        assertEq(splitter.balance, 0, "splitter drained");
    }

    // ---------------------------------------------------------------
    // Reverting-ancestor fallthrough on sale release
    // ---------------------------------------------------------------

    function test_release_revertingAncestorFallsThroughToHolder() public {
        // Mint the grandparent NFT to an EOA first, then transmute that
        // EOA into a reverting receiver via vm.etch so the splitter's
        // .call to it fails. This avoids ERC721 _safeMint rejecting a
        // non-receiver contract at mint time.
        address h1 = address(0xA1);
        address h2 = address(0xA2);
        address h3 = address(0xA3);

        _mint("g1", "", h1);
        _mint("g2", "g1", h2);
        uint256 t3 = _mint("g3", "g2", h3);

        // Inject reverting bytecode at h1 — ancestor release calls now
        // revert at the wallet, exercising the fallthrough path.
        RevertingReceiver bad = new RevertingReceiver();
        vm.etch(h1, address(bad).code);

        address payable splitter = payable(nft.splitterOf(t3));
        vm.deal(splitter, 10 ether);

        uint256 h1Before = h1.balance;
        uint256 h2Before = h2.balance;
        uint256 h3Before = h3.balance;
        uint256 treasuryBefore = treasury.balance;

        EticaResearchRoyaltySplitter(splitter).release();

        // Grandparent (the reverting receiver) does NOT get its 0.32;
        // that slice falls through to the holder. Parent and treasury
        // remain at their normal slices.
        assertEq(treasury.balance - treasuryBefore, 0.1 ether, "treasury slice unchanged");
        assertEq(h2.balance - h2Before, 1.6 ether, "parent paid");
        assertEq(h1.balance - h1Before, 0, "reverting ancestor got nothing");
        assertEq(
            h3.balance - h3Before,
            7.98 ether + 0.32 ether,
            "holder absorbs reverting-ancestor slice"
        );
        assertEq(splitter.balance, 0, "splitter drained");
    }

    // ---------------------------------------------------------------
    // Mint fee cascade: depth-3 mint splits 79/20/1 with cascade upward
    // ---------------------------------------------------------------

    struct CascadeExpected {
        uint256 toTreasury;
        uint256 toHolder;
        uint256 parent;
        uint256 grandparent;
    }

    function _expectedCascade(uint256 amount) internal pure returns (CascadeExpected memory e) {
        e.toTreasury = amount / 100;
        e.toHolder = (amount * 7900) / 10000;
        uint256 pool = amount - e.toTreasury - e.toHolder;
        e.parent = (pool * 8000) / 10000;
        pool -= e.parent;
        e.grandparent = (pool * 8000) / 10000;
        pool -= e.grandparent;
        e.toHolder += pool;
    }

    function test_mintFee_depth3_cascadeUpward() public {
        address h1 = address(0xA1);
        address h2 = address(0xA2);
        address h3 = address(0xA3);
        _mint("g1", "", h1);
        _mint("g2", "g1", h2);

        uint256 h1Before = h1.balance;
        uint256 h2Before = h2.balance;
        uint256 treasuryBefore = treasury.balance;
        vm.deal(h3, 100 ether);
        uint256 h3Before = h3.balance;

        EticaResearchNFT.ClaimPayload memory p = _payload("g3", "g2", h3);
        bytes memory sig = _sign(p, attestorPk);
        uint256 fee = _expectedFee(p.score);
        vm.prank(h3);
        nft.claim{value: fee}(p, sig);

        CascadeExpected memory e = _expectedCascade(fee);
        assertEq(treasury.balance - treasuryBefore, e.toTreasury, "treasury 1%");
        assertEq(h2.balance - h2Before, e.parent, "parent");
        assertEq(h1.balance - h1Before, e.grandparent, "grandparent");
        assertEq(h3Before - h3.balance, fee - e.toHolder, "h3 net cost");
    }

    // ---------------------------------------------------------------
    // ERC-20 release with cascade
    // ---------------------------------------------------------------

    function test_releaseERC20_depth3_cascade() public {
        address h1 = address(0xA1);
        address h2 = address(0xA2);
        address h3 = address(0xA3);

        _mint("g1", "", h1);
        _mint("g2", "g1", h2);
        uint256 t3 = _mint("g3", "g2", h3);

        address payable splitter = payable(nft.splitterOf(t3));
        MockERC20 token = new MockERC20("Mock", "MCK");
        token.mint(splitter, 10_000 ether);

        EticaResearchRoyaltySplitter(splitter).releaseERC20(IERC20(address(token)));

        assertEq(token.balanceOf(treasury), 100 ether, "treasury 1%");
        assertEq(token.balanceOf(h2), 1600 ether, "parent 16%");
        assertEq(token.balanceOf(h1), 320 ether, "grandparent 3.2%");
        assertEq(token.balanceOf(h3), 7980 ether, "holder 79% + geo remainder");
        assertEq(token.balanceOf(splitter), 0, "splitter drained");
    }
}
