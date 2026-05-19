// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

interface IEticaResearchNFTForSplitter {
    function treasury() external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title EticaResearchRoyaltySplitter
/// @notice One per cure NFT. Acts as the ERC-2981 royalty receiver
///         address for that specific token: marketplaces send the
///         royalty value (native EGAZ or any ERC-20 the sale was
///         denominated in) here on every secondary sale, and the
///         appropriate {release} variant forwards 80% to the
///         **current holder** of the NFT and 20% to the EticaHub
///         treasury.
///
/// @dev    Royalty follows ownership. The 80% leg is resolved at
///         release() time from the NFT contract's {ownerOf} — so
///         selling the NFT transfers the future royalty stream to
///         the buyer along with the token itself. The original
///         discoverer's address is recorded immutably on the NFT
///         in {submitterOf} for attribution / provenance, but it
///         does not gate any payout.
///
/// @dev    Per-token isolation is the whole point. ERC-2981 royalty
///         payments arrive as plain {receive} value transfers (or
///         bare ERC-20 transfers to this address) with no tokenId
///         metadata, so a single shared splitter would conflate
///         every token's pending balance. Giving each tokenId its
///         own splitter address means funds for token N can only
///         ever be claimed against token N's current owner + the
///         (immutable) treasury — no cross-contamination, no
///         first-comer-takes-all race.
///
/// @dev    Asset-agnostic. The in-app marketplace settles listings
///         in whatever ERC-20 (or native EGAZ) the seller specified.
///         The royalty leg of each sale is forwarded to this
///         splitter in the **same asset** as the sale, so the
///         splitter may simultaneously hold balances in EGAZ,
///         ETX, stETX, USDT, etc., each accounted independently.
///
/// @dev    Zero admin surface. The {nft} contract reference and
///         {tokenId} are baked in at construction; the split ratio
///         is hard-coded; there are no upgrade or pause functions
///         and there is no sweep / rescue path. Worst case if the
///         EticaHub operator wallet is compromised: attacker still
///         cannot redirect any existing splitter's funds — the
///         treasury address and the per-token holder are read from
///         the immutable NFT contract's state, which the operator
///         wallet has no power to overwrite either.
///
/// @dev    If the NFT is burned, {ownerOf} reverts and both
///         {release} variants become uncallable — funds previously
///         paid to this splitter are permanently locked. This is
///         by design: burning is a destructive opt-in by the
///         holder, and we do not bake any admin recovery path.
contract EticaResearchRoyaltySplitter {
    using SafeERC20 for IERC20;

    error TransferFailed();
    error NothingToRelease();
    error TokenZero();

    /// @notice Holder share, in basis points of the splitter's balance.
    /// @dev    Treasury share is the remainder (10000 - HOLDER_BPS).
    uint16 public constant HOLDER_BPS = 8000; // 80%

    /// @notice Address of the EticaResearchNFT contract that owns this
    ///         splitter. Read at release() time to resolve the current
    ///         treasury + current NFT owner.
    address public immutable nft;

    /// @notice The single tokenId this splitter is associated with.
    uint256 public immutable tokenId;

    /// @notice Cumulative native EGAZ released to the holder leg so
    ///         far (across all historical holders of this token).
    uint256 public holderReleased;

    /// @notice Cumulative native EGAZ released to the treasury so far.
    uint256 public treasuryReleased;

    /// @notice Cumulative ERC-20 token amount released to the holder
    ///         leg, keyed by ERC-20 contract address.
    mapping(address => uint256) public holderReleasedToken;

    /// @notice Cumulative ERC-20 token amount released to the treasury
    ///         leg, keyed by ERC-20 contract address.
    mapping(address => uint256) public treasuryReleasedToken;

    /// @notice Lifetime native EGAZ that has flowed through this
    ///         splitter (released to holders + released to treasury
    ///         + current on-chain balance). Off-chain analytics aid.
    function lifetimeFlow() external view returns (uint256) {
        return holderReleased + treasuryReleased + address(this).balance;
    }

    /// @notice Lifetime ERC-20 amount that has flowed through this
    ///         splitter for the given token (released to holders +
    ///         released to treasury + current on-chain balance).
    function lifetimeFlowToken(address token) external view returns (uint256) {
        return holderReleasedToken[token] + treasuryReleasedToken[token]
            + IERC20(token).balanceOf(address(this));
    }

    /// @notice Emitted on each successful native {release} call.
    event Released(
        address indexed caller,
        address indexed holder,
        address indexed treasury,
        uint256 toHolder,
        uint256 toTreasury
    );

    /// @notice Emitted on each successful {releaseERC20} call.
    event ReleasedERC20(
        address indexed caller,
        address indexed token,
        address indexed holder,
        address treasury,
        uint256 toHolder,
        uint256 toTreasury
    );

    constructor(address nft_, uint256 tokenId_) {
        nft = nft_;
        tokenId = tokenId_;
    }

    // Accept value from marketplaces without function call.
    receive() external payable {}

    /// @notice Forward the entire current native balance — 80% to
    ///         the cure NFT's current holder, 20% to the EticaHub
    ///         treasury. Permissionless: anyone may call.
    /// @dev    Uses .call to be tolerant of recipient contracts that
    ///         need >2300 gas (e.g. Gnosis Safe). Re-entrancy is
    ///         neutralized by computing both transfer amounts up
    ///         front from the snapshot balance.
    function release() external {
        uint256 bal = address(this).balance;
        if (bal == 0) revert NothingToRelease();

        IEticaResearchNFTForSplitter nftRef = IEticaResearchNFTForSplitter(nft);
        address holder = nftRef.ownerOf(tokenId);
        address treasuryAddr = nftRef.treasury();

        uint256 toHolder = (bal * HOLDER_BPS) / 10000;
        uint256 toTreasury = bal - toHolder;

        holderReleased += toHolder;
        treasuryReleased += toTreasury;

        if (toHolder > 0) {
            (bool ok,) = payable(holder).call{value: toHolder}("");
            if (!ok) revert TransferFailed();
        }
        if (toTreasury > 0) {
            (bool ok,) = payable(treasuryAddr).call{value: toTreasury}("");
            if (!ok) revert TransferFailed();
        }

        emit Released(msg.sender, holder, treasuryAddr, toHolder, toTreasury);
    }

    /// @notice Forward the entire current balance of a specific
    ///         ERC-20 — 80% to the cure NFT's current holder,
    ///         20% to the EticaHub treasury. Permissionless:
    ///         anyone may call. Use this whenever a sale settled
    ///         in an ERC-20 (ETX, stETX, USDT, etc.) instead of
    ///         native EGAZ.
    /// @dev    Uses SafeERC20 so non-standard tokens (missing
    ///         return value, etc.) still work. Each token's
    ///         accounting is independent — releasing ETX does
    ///         not touch stETX bookkeeping.
    function releaseERC20(IERC20 token) external {
        if (address(token) == address(0)) revert TokenZero();

        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) revert NothingToRelease();

        IEticaResearchNFTForSplitter nftRef = IEticaResearchNFTForSplitter(nft);
        address holder = nftRef.ownerOf(tokenId);
        address treasuryAddr = nftRef.treasury();

        uint256 toHolder = (bal * HOLDER_BPS) / 10000;
        uint256 toTreasury = bal - toHolder;

        holderReleasedToken[address(token)] += toHolder;
        treasuryReleasedToken[address(token)] += toTreasury;

        if (toHolder > 0) {
            token.safeTransfer(holder, toHolder);
        }
        if (toTreasury > 0) {
            token.safeTransfer(treasuryAddr, toTreasury);
        }

        emit ReleasedERC20(msg.sender, address(token), holder, treasuryAddr, toHolder, toTreasury);
    }
}
