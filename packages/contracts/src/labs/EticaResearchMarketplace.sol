// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The subset of EticaResearchNFT this marketplace reads to price
///         and authorise treasury auto-listings.
interface IEticaResearchNFTView {
    function treasury() external view returns (address);
    function BASE_MINT_FEE_WEI() external view returns (uint256);
    function MAX_SCORE_MINT_FEE_WEI() external view returns (uint256);
    function discoveryOf(uint256 tokenId)
        external
        view
        returns (
            string memory parentGoalTitle,
            string memory sequence,
            string memory analysis,
            uint256 score,
            uint256 iterations,
            string memory branchGoalId,
            address submitter,
            uint64 discoveredAt,
            uint64 blockNumber
        );
}

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
///         - Research abandoned past its 7-day window is force-minted to the
///           treasury by the NFT itself, and the treasury holds no automation
///           key. {listAbandoned} therefore lets anyone put such a token on
///           sale on the treasury's behalf, at a price derived on-chain from
///           the record's own mint fee, so the caller has no discretion over
///           price or recipient. The treasury opts a token back out by
///           cancelling it.
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

    /// @notice Same contract as {nft}, typed for the research-record reads
    ///         that price a treasury auto-listing.
    IEticaResearchNFTView public immutable research;

    /// @notice Auto-listing price as basis points of the record's own mint
    ///         fee (`10000` = mint fee, `20000` = twice it). Immutable, so
    ///         an abandoned-research listing price is a pure function of the
    ///         token and no caller can set it.
    uint256 public immutable abandonedPriceBps;

    /// @notice tokenId => active listing. seller == address(0) means unlisted.
    mapping(uint256 => Listing) public listings;

    /// @notice All tokenIds that currently have an active listing.
    ///         Maintained for off-chain enumeration (frontend browse page).
    uint256[] public listedTokenIds;

    /// @notice Index+1 of a tokenId in listedTokenIds (0 = not listed).
    mapping(uint256 => uint256) internal _listedIndex;

    /// @notice tokenIds the treasury has cancelled, which {listAbandoned}
    ///         must not put back on sale. Cleared when the treasury lists
    ///         the token itself.
    mapping(uint256 => bool) public autoListDisabled;

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
    event AutoListDisabledSet(uint256 indexed tokenId, bool disabled);

    // ─── Errors ─────────────────────────────────────────────────────────

    error NotOwner();
    error NotApproved();
    error PriceZero();
    error NotListed();
    error CannotBuyOwn();
    error InsufficientPayment();
    error TransferFailed();
    error NotTreasuryOwned();
    error AlreadyListed();
    error AutoListDisabled();
    error NotTreasury();

    // ─── Constructor ────────────────────────────────────────────────────

    constructor(address nft_, uint256 abandonedPriceBps_) {
        nft = IERC721(nft_);
        research = IEticaResearchNFTView(nft_);
        abandonedPriceBps = abandonedPriceBps_;
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

        autoListDisabled[tokenId] = false;
        _store(tokenId, msg.sender, price);
        emit Listed(tokenId, msg.sender, price);
    }

    /// @notice Put a treasury-held research NFT on sale on the treasury's
    ///         behalf, at {abandonedPriceOf}. Callable by anyone: the
    ///         recipient of the sale is the treasury and the price is fixed
    ///         by the token's own record, so the caller gains nothing but
    ///         the gas bill. Reverts once the treasury has cancelled the
    ///         listing, which is how it takes a token off the rail.
    function listAbandoned(uint256 tokenId) external returns (uint128 price) {
        address treasury = research.treasury();
        if (nft.ownerOf(tokenId) != treasury) revert NotTreasuryOwned();
        if (listings[tokenId].seller != address(0)) revert AlreadyListed();
        if (autoListDisabled[tokenId]) revert AutoListDisabled();
        if (
            !nft.isApprovedForAll(treasury, address(this))
                && nft.getApproved(tokenId) != address(this)
        ) revert NotApproved();

        price = abandonedPriceOf(tokenId);
        if (price == 0) revert PriceZero();

        _store(tokenId, treasury, price);
        emit Listed(tokenId, treasury, price);
    }

    /// @notice Treasury-only switch for the permissionless rail. Lets the
    ///         treasury shield a token it holds for reasons other than
    ///         forfeiture (bought, gifted) before anyone can
    ///         {listAbandoned} it, and re-arm a token it cancelled earlier.
    function setAutoListDisabled(uint256 tokenId, bool disabled) external {
        if (msg.sender != research.treasury()) revert NotTreasury();
        autoListDisabled[tokenId] = disabled;
        emit AutoListDisabledSet(tokenId, disabled);
    }

    /// @notice Cancel a listing. Only the seller (current owner) can cancel.
    function cancel(uint256 tokenId) external {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed();
        if (l.seller != msg.sender) revert NotOwner();

        if (msg.sender == research.treasury()) autoListDisabled[tokenId] = true;
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

    /// @notice The price {listAbandoned} would use for `tokenId`: the mint
    ///         fee the record would have cost a researcher, scaled by
    ///         {abandonedPriceBps}. Higher-scoring research lists higher.
    function abandonedPriceOf(uint256 tokenId) public view returns (uint128) {
        (,,, uint256 score,,,,,) = research.discoveryOf(tokenId);
        uint256 mintFee = research.BASE_MINT_FEE_WEI()
            + (research.MAX_SCORE_MINT_FEE_WEI() * score) / 10_000;
        return uint128((mintFee * abandonedPriceBps) / 10_000);
    }

    /// @notice Check if a tokenId is currently listed.
    function isListed(uint256 tokenId) external view returns (bool) {
        return listings[tokenId].seller != address(0);
    }

    // ─── Internal ───────────────────────────────────────────────────────

    function _store(uint256 tokenId, address seller, uint128 price) internal {
        listings[tokenId] =
            Listing({seller: seller, price: price, listedAt: uint64(block.timestamp)});

        if (_listedIndex[tokenId] == 0) {
            listedTokenIds.push(tokenId);
            _listedIndex[tokenId] = listedTokenIds.length; // 1-based
        }
    }

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
