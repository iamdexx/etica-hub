// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EticaResearchNFT} from "../../src/labs/EticaResearchNFT.sol";
import {EticaResearchMarketplace} from "../../src/labs/EticaResearchMarketplace.sol";

contract EticaResearchMarketplaceTest is Test {
    bytes32 internal constant CLAIM_TYPEHASH = keccak256(
        "ClaimPayload(string parentGoalTitle,string sequence,string analysis,uint256 score,uint256 iterations,string branchGoalId,address submitter,uint64 expiresAt,uint64 exclusiveUntil,string parentBranchGoalId)"
    );

    EticaResearchNFT internal nft;
    EticaResearchMarketplace internal market;

    uint256 internal attestorPk = 0xA77E5708;
    address internal attestor;
    address internal treasury = address(0xDEAFBEEF);
    address internal seller = address(0xB0B);
    address internal buyer = address(0xBA1A);

    function setUp() public {
        attestor = vm.addr(attestorPk);
        nft = new EticaResearchNFT(
            attestor, treasury, "https://eticahub.com", 0.01 ether, 0.99 ether
        );
        market = new EticaResearchMarketplace(address(nft));
        vm.warp(1_700_000_000);
        vm.deal(seller, 100 ether);
        vm.deal(buyer, 100 ether);

        // Mint a token to seller
        _mintTo(seller, "branch_001");
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _mintTo(address to, string memory branchId) internal {
        EticaResearchNFT.ClaimPayload memory p = EticaResearchNFT.ClaimPayload({
            parentGoalTitle: "Test research",
            sequence: "MAGSKLRPDFNCYK",
            analysis: "Test analysis",
            score: 9100,
            iterations: 14,
            branchGoalId: branchId,
            submitter: to,
            expiresAt: uint64(block.timestamp + 1 days),
            exclusiveUntil: uint64(block.timestamp + 7 days),
            parentBranchGoalId: ""
        });
        bytes memory sig = _sign(p, attestorPk);
        uint256 fee = 0.01 ether + (0.99 ether * 9100) / 10_000;
        vm.prank(to);
        nft.claim{value: fee}(p, sig);
    }

    function _sign(EticaResearchNFT.ClaimPayload memory p, uint256 pk)
        internal
        view
        returns (bytes memory)
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
                keccak256(bytes(p.parentBranchGoalId))
            )
        );
        (, string memory name, string memory version, uint256 chainId, address vc,,) =
            nft.eip712Domain();
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                vc
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ─── Tests ──────────────────────────────────────────────────────────

    function test_list_and_buy() public {
        uint256 tokenId = 1;
        uint128 price = 1 ether;

        // Seller approves marketplace
        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);

        // List
        vm.prank(seller);
        market.list(tokenId, price);

        assertEq(market.totalListings(), 1);
        assertTrue(market.isListed(tokenId));

        // Check listing data
        (address listedSeller, uint128 listedPrice,) = market.listings(tokenId);
        assertEq(listedSeller, seller);
        assertEq(listedPrice, price);

        // Buyer purchases
        uint256 sellerBalBefore = seller.balance;
        vm.prank(buyer);
        market.buy{value: price}(tokenId);

        // NFT transferred to buyer
        assertEq(nft.ownerOf(tokenId), buyer);
        // Listing removed
        assertFalse(market.isListed(tokenId));
        assertEq(market.totalListings(), 0);
        // Seller received proceeds (price minus royalty)
        assertTrue(seller.balance > sellerBalBefore);
    }

    function test_list_reverts_nonOwner() public {
        vm.prank(buyer);
        vm.expectRevert(EticaResearchMarketplace.NotOwner.selector);
        market.list(1, 1 ether);
    }

    function test_list_reverts_priceZero() public {
        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);
        vm.prank(seller);
        vm.expectRevert(EticaResearchMarketplace.PriceZero.selector);
        market.list(1, 0);
    }

    function test_list_reverts_notApproved() public {
        vm.prank(seller);
        vm.expectRevert(EticaResearchMarketplace.NotApproved.selector);
        market.list(1, 1 ether);
    }

    function test_cancel() public {
        vm.startPrank(seller);
        nft.setApprovalForAll(address(market), true);
        market.list(1, 1 ether);
        market.cancel(1);
        vm.stopPrank();

        assertFalse(market.isListed(1));
        assertEq(market.totalListings(), 0);
    }

    function test_cancel_reverts_notSeller() public {
        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);
        vm.prank(seller);
        market.list(1, 1 ether);

        vm.prank(buyer);
        vm.expectRevert(EticaResearchMarketplace.NotOwner.selector);
        market.cancel(1);
    }

    function test_buy_reverts_insufficientPayment() public {
        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);
        vm.prank(seller);
        market.list(1, 1 ether);

        vm.prank(buyer);
        vm.expectRevert(EticaResearchMarketplace.InsufficientPayment.selector);
        market.buy{value: 0.5 ether}(1);
    }

    function test_buy_reverts_ownPurchase() public {
        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);
        vm.prank(seller);
        market.list(1, 1 ether);

        vm.prank(seller);
        vm.expectRevert(EticaResearchMarketplace.CannotBuyOwn.selector);
        market.buy{value: 1 ether}(1);
    }

    function test_buy_refundsExcess() public {
        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);
        vm.prank(seller);
        market.list(1, 1 ether);

        uint256 buyerBalBefore = buyer.balance;
        vm.prank(buyer);
        market.buy{value: 2 ether}(1);

        // Buyer should get ~1 ether back (minus gas etc in real scenario)
        // In test, exact: buyer paid 2 ether, got 1 ether refund
        // so net cost = 1 ether (the listing price)
        assertEq(nft.ownerOf(1), buyer);
        // buyer balance = before - price (royalty comes from price, not extra)
        assertEq(buyer.balance, buyerBalBefore - 1 ether);
    }

    function test_royalty_paid_on_sale() public {
        uint256 tokenId = 1;
        uint128 price = 10 ether;

        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);
        vm.prank(seller);
        market.list(tokenId, price);

        // Get royalty info
        (address royaltyReceiver, uint256 royaltyAmount) = nft.royaltyInfo(tokenId, price);
        assertTrue(royaltyAmount > 0, "royalty should be nonzero");

        uint256 receiverBalBefore = royaltyReceiver.balance;
        uint256 sellerBalBefore = seller.balance;

        vm.prank(buyer);
        market.buy{value: price}(tokenId);

        // Royalty receiver got paid
        assertEq(royaltyReceiver.balance, receiverBalBefore + royaltyAmount);
        // Seller got price minus royalty
        assertEq(seller.balance, sellerBalBefore + uint256(price) - royaltyAmount);
    }

    function test_getListings_pagination() public {
        // Mint a second token
        _mintTo(seller, "branch_002");

        vm.startPrank(seller);
        nft.setApprovalForAll(address(market), true);
        market.list(1, 1 ether);
        market.list(2, 2 ether);
        vm.stopPrank();

        (uint256[] memory ids, EticaResearchMarketplace.Listing[] memory items) =
            market.getListings(0, 10);
        assertEq(ids.length, 2);
        assertEq(items[0].price, 1 ether);
        assertEq(items[1].price, 2 ether);

        // Paginated
        (uint256[] memory ids2,) = market.getListings(1, 1);
        assertEq(ids2.length, 1);
        assertEq(ids2[0], 2);
    }
}
