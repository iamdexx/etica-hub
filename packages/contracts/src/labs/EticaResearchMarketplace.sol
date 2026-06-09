// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title EticaResearchMarketplace
/// @notice Fixed-price NFT marketplace for EticaResearchNFT. Sellers list at
///         a native EGAZ price, buyers pay that price, and ERC-2981 royalties
///         are automatically forwarded to the per-token splitter (which then
///         distributes 79/20/1 holder/ancestor/treasury).
///
/// @dev    DESIGN:
///         - No admin, no owner, no pause, no fees beyond ERC-2981 royalties.
///         - Listings are per-token: one active listing per tokenId.
///         - Seller must approve this contract before listing.
///         - On buy: royalty is split off and sent to the royalty receiver,
///           remainder goes to the seller, NFT goes to the buyer.
///         - Seller can cancel anytime if still owner.
///         - If the NFT is transferred away externally, the listing becomes
///           stale and buy() reverts (ownerOf check).
contract EticaResearchMarketplace is ReentrancyGuard {
    // ─── Types ──────────────────────────────────────────────────────────

    struct Listing {
        address seller;
        uint128 price; // in wei (EGAZ)
        uint64 listedAt;
    }

    // ─── State ──────────────────────────────────────────────────────────

    /// @notice The EticaResearchNFT contract this marketplace trades.
    IERC721 public immutable nft;

    /// @notice tokenId => active listing. seller == address(0) means unlisted.
    mapping(uint256 => Listing) public listings;

    /// @notice All tokenIds that currently have an active listing.
    ///         Maintained for off-chain enumeration (frontend browse page).
    uint256[] public listedTokenIds;

    /// @notice Index+1 of a tokenId in listedTokenIds (0 = not listed).
    mapping(uint256 => uint256) internal _listedIndex;

    // ─── Events ─────────────────────────────────────────────────────────

    event Listed(uint256 indexed tokenId, address indexed seller, uint128 price);
    event Unlisted(uint256 indexed tokenId, address indexed seller);
    event Sold(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed buyer,
        uint128 price,
        uint256 royaltyPaid
    );

    // ─── Errors ─────────────────────────────────────────────────────────

    error NotOwner();
    error NotApproved();
    error PriceZero();
    error NotListed();
    error CannotBuyOwn();
    error InsufficientPayment();
    error TransferFailed();

    // ─── Constructor ────────────────────────────────────────────────────

    constructor(address nft_) {
        nft = IERC721(nft_);
    }

    // ─── Write ──────────────────────────────────────────────────────────

    /// @notice List an NFT for sale at a fixed EGAZ price.
    ///         Caller must be the current owner and must have approved this
    ///         contract (setApprovalForAll or approve).
    function list(uint256 tokenId, uint128 price) external {
        if (price == 0) revert PriceZero();
        if (nft.ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (
            !nft.isApprovedForAll(msg.sender, address(this))
                && nft.getApproved(tokenId) != address(this)
        ) revert NotApproved();

        listings[tokenId] =
            Listing({seller: msg.sender, price: price, listedAt: uint64(block.timestamp)});

        // Add to enumerable set if not already present
        if (_listedIndex[tokenId] == 0) {
            listedTokenIds.push(tokenId);
            _listedIndex[tokenId] = listedTokenIds.length; // 1-based
        }

        emit Listed(tokenId, msg.sender, price);
    }

    /// @notice Cancel a listing. Only the seller (current owner) can cancel.
    function cancel(uint256 tokenId) external {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed();
        if (l.seller != msg.sender) revert NotOwner();

        _removeListing(tokenId);
        emit Unlisted(tokenId, msg.sender);
    }

    /// @notice Buy a listed NFT by sending exact price in EGAZ.
    ///         ERC-2981 royalty is auto-deducted and sent to the royalty
    ///         receiver (the per-token splitter). Remaining goes to seller.
    function buy(uint256 tokenId) external payable nonReentrant {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed();
        if (msg.sender == l.seller) revert CannotBuyOwn();
        if (msg.value < l.price) revert InsufficientPayment();

        // Verify seller still owns the token (catches stale listings)
        if (nft.ownerOf(tokenId) != l.seller) {
            _removeListing(tokenId);
            revert NotListed();
        }

        // Calculate ERC-2981 royalty
        uint256 royaltyAmount = 0;
        address royaltyReceiver = address(0);
        try IERC2981(address(nft)).royaltyInfo(tokenId, l.price) returns (
            address receiver, uint256 amount
        ) {
            royaltyReceiver = receiver;
            royaltyAmount = amount;
        } catch {}

        // Remove listing before external calls (CEI)
        _removeListing(tokenId);

        // Transfer NFT to buyer
        nft.transferFrom(l.seller, msg.sender, tokenId);

        // Pay royalty to splitter
        if (royaltyAmount > 0 && royaltyReceiver != address(0)) {
            (bool royaltyOk,) = royaltyReceiver.call{value: royaltyAmount}("");
            if (!royaltyOk) revert TransferFailed();
        }

        // Pay seller (price minus royalty)
        uint256 sellerProceeds = uint256(l.price) - royaltyAmount;
        if (sellerProceeds > 0) {
            (bool sellerOk,) = l.seller.call{value: sellerProceeds}("");
            if (!sellerOk) revert TransferFailed();
        }

        // Refund excess payment
        if (msg.value > l.price) {
            (bool refundOk,) = msg.sender.call{value: msg.value - l.price}("");
            if (!refundOk) revert TransferFailed();
        }

        emit Sold(tokenId, l.seller, msg.sender, l.price, royaltyAmount);
    }

    // ─── View ───────────────────────────────────────────────────────────

    /// @notice Total number of active listings.
    function totalListings() external view returns (uint256) {
        return listedTokenIds.length;
    }

    /// @notice Get a page of active listings for frontend enumeration.
    /// @param offset Start index in listedTokenIds.
    /// @param limit  Max entries to return.
    function getListings(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory tokenIds, Listing[] memory items)
    {
        uint256 total = listedTokenIds.length;
        if (offset >= total) return (new uint256[](0), new Listing[](0));
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 count = end - offset;
        tokenIds = new uint256[](count);
        items = new Listing[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 tid = listedTokenIds[offset + i];
            tokenIds[i] = tid;
            items[i] = listings[tid];
        }
    }

    /// @notice Check if a tokenId is currently listed.
    function isListed(uint256 tokenId) external view returns (bool) {
        return listings[tokenId].seller != address(0);
    }

    // ─── Internal ───────────────────────────────────────────────────────

    function _removeListing(uint256 tokenId) internal {
        delete listings[tokenId];

        uint256 idx = _listedIndex[tokenId];
        if (idx == 0) return; // not in array
        uint256 lastIdx = listedTokenIds.length;
        if (idx != lastIdx) {
            // Swap with last
            uint256 lastTokenId = listedTokenIds[lastIdx - 1];
            listedTokenIds[idx - 1] = lastTokenId;
            _listedIndex[lastTokenId] = idx;
        }
        listedTokenIds.pop();
        delete _listedIndex[tokenId];
    }
}
