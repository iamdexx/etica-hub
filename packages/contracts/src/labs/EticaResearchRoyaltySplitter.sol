// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

interface IEticaResearchNFTForSplitter {
    function treasury() external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getAncestorHolders(uint256 tokenId) external view returns (address[] memory);
}

/// @title EticaResearchRoyaltySplitter
/// @notice One per research NFT. Acts as the ERC-2981 royalty receiver
///         address for that specific token: marketplaces send the
///         royalty value (native EGAZ or any ERC-20 the sale was
///         denominated in) here on every secondary sale, and the
///         appropriate {release} variant forwards
///
///           - 79% to the **current holder** of the NFT,
///           - 20% to the ancestor chain (geometrically split 80/20
///                per level, capped at depth 25),
///           - 1%  to the EticaHub treasury.
///
/// @dev    Royalty follows ownership. The 79% holder leg and every
///         ancestor leg are resolved at release() time from the NFT
///         contract's {ownerOf}, so selling any NFT in the chain
///         transfers its future royalty stream to the buyer. The
///         original discoverer's address is recorded immutably on
///         the NFT in {submitterOf} for attribution / provenance,
///         but it does not gate any payout.
///
/// @dev    Per-token isolation. ERC-2981 royalty payments arrive as
///         plain {receive} value transfers (or bare ERC-20 transfers)
///         with no tokenId metadata, so a single shared splitter
///         would conflate every token's pending balance. Giving each
///         tokenId its own splitter address means funds for token N
///         can only ever be claimed against token N's holder
///         + token N's ancestor chain + the immutable treasury.
///
/// @dev    Asset-agnostic. The in-app marketplace settles listings
///         in whatever ERC-20 (or native EGAZ) the seller specified.
///         The royalty leg of each sale is forwarded to this
///         splitter in the **same asset** as the sale, so the
///         splitter may simultaneously hold balances in EGAZ,
///         ETX, stETX, USDT, etc., each accounted independently.
///
/// @dev    Ancestor reverts fall through to the current holder, never
///         treasury. A reverting ancestor wallet (contract whose
///         {receive}/{fallback} reverts, or an ERC-20 transfer that
///         the token contract rejects) cannot brick the release —
///         their slice is added to the holder's payout instead.
///         Treasury's 1% slice is strict (release reverts on failure)
///         to preserve the "treasury is exactly 1%, never more" rule.
///
/// @dev    Zero admin surface. The {nft} contract reference and
///         {tokenId} are baked in at construction; the split ratios
///         are hard-coded; there are no upgrade or pause functions
///         and there is no sweep / rescue path.
///
/// @dev    If the NFT is burned, {ownerOf} reverts and both
///         {release} variants become uncallable — funds previously
///         paid to this splitter are permanently locked. This is
///         by design: burning is a destructive opt-in by the
///         holder, and we do not bake any admin recovery path.
contract EticaResearchRoyaltySplitter {
    error TransferFailed();
    error NothingToRelease();
    error TokenZero();

    /// @notice Current-holder share, in basis points of the splitter's balance.
    uint16 public constant HOLDER_BPS = 7900; // 79%

    /// @notice Ancestor-chain pool share, in basis points. Cascaded
    ///         geometrically 80/20 across up to {MAX_ANCESTOR_DEPTH}
    ///         levels (resolved on the NFT contract). Any geometric
    ///         remainder (and any reverting-ancestor slice) falls
    ///         through to the holder leg.
    uint16 public constant ANCESTOR_BPS = 2000; // 20%

    /// @notice Treasury share, in basis points. Always exactly 1%.
    uint16 public constant TREASURY_BPS = 100; // 1%

    /// @notice Per-level geometric ratio applied to the ancestor pool.
    ///         Each ancestor receives 80% of the running pool; the
    ///         remaining 20% is passed up to the next level.
    uint16 internal constant ANCESTOR_LEVEL_BPS = 8000;

    /// @notice Address of the EticaResearchNFT contract that owns this
    ///         splitter. Read at release() time to resolve the
    ///         treasury, the current NFT owner, and the ancestor chain.
    address public immutable nft;

    /// @notice The single tokenId this splitter is associated with.
    uint256 public immutable tokenId;

    /// @notice Cumulative native EGAZ released to the holder leg so
    ///         far (across all historical holders of this token).
    ///         Includes any geometric remainder and reverting-ancestor
    ///         fallthrough.
    uint256 public holderReleased;

    /// @notice Cumulative native EGAZ released to ancestors so far,
    ///         summed across the entire chain. Per-ancestor values
    ///         are not tracked individually; off-chain analytics can
    ///         derive them from {Released} event logs.
    uint256 public ancestorReleased;

    /// @notice Cumulative native EGAZ released to the treasury so far.
    uint256 public treasuryReleased;

    /// @notice Cumulative ERC-20 token amount released to the holder
    ///         leg, keyed by ERC-20 contract address.
    mapping(address => uint256) public holderReleasedToken;

    /// @notice Cumulative ERC-20 token amount released to ancestors,
    ///         summed across the entire chain, keyed by ERC-20
    ///         contract address.
    mapping(address => uint256) public ancestorReleasedToken;

    /// @notice Cumulative ERC-20 token amount released to the treasury
    ///         leg, keyed by ERC-20 contract address.
    mapping(address => uint256) public treasuryReleasedToken;

    /// @notice Lifetime native EGAZ that has flowed through this
    ///         splitter (released to holders + released to ancestors
    ///         + released to treasury + current on-chain balance).
    function lifetimeFlow() external view returns (uint256) {
        return holderReleased + ancestorReleased + treasuryReleased + address(this).balance;
    }

    /// @notice Lifetime ERC-20 amount that has flowed through this
    ///         splitter for the given token.
    function lifetimeFlowToken(address token) external view returns (uint256) {
        return holderReleasedToken[token] + ancestorReleasedToken[token]
            + treasuryReleasedToken[token] + IERC20(token).balanceOf(address(this));
    }

    /// @notice Emitted on each successful native {release} call.
    /// @param  toHolder      Holder slice (79% + geometric remainder +
    ///                       reverting-ancestor fallthrough).
    /// @param  toAncestors   Sum of all ancestor slices successfully
    ///                       forwarded (excludes amounts that reverted
    ///                       and fell through to the holder).
    /// @param  toTreasury    Treasury slice (exactly 1% of the
    ///                       snapshot balance).
    event Released(
        address indexed caller,
        address indexed holder,
        address indexed treasury,
        uint256 toHolder,
        uint256 toAncestors,
        uint256 toTreasury
    );

    /// @notice Emitted on each successful {releaseERC20} call.
    event ReleasedERC20(
        address indexed caller,
        address indexed token,
        address indexed holder,
        address treasury,
        uint256 toHolder,
        uint256 toAncestors,
        uint256 toTreasury
    );

    /// @notice Emitted once per ancestor leg actually paid out. One
    ///         release() call can emit up to {MAX_ANCESTOR_DEPTH}
    ///         {AncestorPaid} events (or zero, for a root token).
    event AncestorPaid(
        address indexed token, address indexed ancestor, uint256 depth, uint256 amount
    );

    constructor(address nft_, uint256 tokenId_) {
        nft = nft_;
        tokenId = tokenId_;
    }

    // Accept value from marketplaces without function call.
    receive() external payable {}

    /// @notice Forward the entire current native balance — 79% to the
    ///         NFT's current holder, 20% to the ancestor chain
    ///         (geometric 80/20 per level, depth-25 cap), 1% to the
    ///         EticaHub treasury. Permissionless: anyone may call.
    /// @dev    Uses .call to be tolerant of recipient contracts that
    ///         need >2300 gas. Re-entrancy is neutralized by computing
    ///         every transfer amount up front from the snapshot
    ///         balance before any external interaction.
    function release() external {
        uint256 bal = address(this).balance;
        if (bal == 0) revert NothingToRelease();

        IEticaResearchNFTForSplitter nftRef = IEticaResearchNFTForSplitter(nft);
        address holder = nftRef.ownerOf(tokenId);
        address treasuryAddr = nftRef.treasury();
        address[] memory ancestors = nftRef.getAncestorHolders(tokenId);

        (uint256 toHolder, uint256[] memory ancestorAmounts, uint256 toTreasury) =
            _computeSplit(bal, ancestors.length);

        // Send treasury — strict. Treasury must always receive exactly 1%.
        if (toTreasury > 0) {
            (bool ok,) = payable(treasuryAddr).call{value: toTreasury}("");
            if (!ok) revert TransferFailed();
        }

        // Send ancestors — failures fall through to holder leg.
        uint256 totalToAncestors = 0;
        for (uint256 i = 0; i < ancestors.length; i++) {
            uint256 amt = ancestorAmounts[i];
            if (amt == 0) continue;
            (bool ok,) = payable(ancestors[i]).call{value: amt}("");
            if (ok) {
                totalToAncestors += amt;
                emit AncestorPaid(address(0), ancestors[i], i + 1, amt);
            } else {
                toHolder += amt;
            }
        }

        // Send holder — strict (revert if the primary recipient is broken).
        if (toHolder > 0) {
            (bool ok,) = payable(holder).call{value: toHolder}("");
            if (!ok) revert TransferFailed();
        }

        holderReleased += toHolder;
        ancestorReleased += totalToAncestors;
        treasuryReleased += toTreasury;

        emit Released(msg.sender, holder, treasuryAddr, toHolder, totalToAncestors, toTreasury);
    }

    /// @notice Forward the entire current balance of a specific
    ///         ERC-20 — 79% to the current holder, 20% to the
    ///         ancestor chain (geometric 80/20 per level, depth-25
    ///         cap), 1% to the EticaHub treasury. Permissionless.
    /// @dev    Uses a low-level call so non-standard ERC-20s (missing
    ///         return value, etc.) still work. Ancestor transfer
    ///         failures fall through to the holder leg.
    function releaseERC20(IERC20 token) external {
        if (address(token) == address(0)) revert TokenZero();

        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) revert NothingToRelease();

        IEticaResearchNFTForSplitter nftRef = IEticaResearchNFTForSplitter(nft);
        address holder = nftRef.ownerOf(tokenId);
        address treasuryAddr = nftRef.treasury();
        address[] memory ancestors = nftRef.getAncestorHolders(tokenId);

        (uint256 toHolder, uint256[] memory ancestorAmounts, uint256 toTreasury) =
            _computeSplit(bal, ancestors.length);

        // Send treasury — strict.
        if (toTreasury > 0) {
            if (!_safeTransfer(token, treasuryAddr, toTreasury)) revert TransferFailed();
        }

        // Send ancestors — failures fall through to holder leg.
        uint256 totalToAncestors = 0;
        for (uint256 i = 0; i < ancestors.length; i++) {
            uint256 amt = ancestorAmounts[i];
            if (amt == 0) continue;
            if (_safeTransfer(token, ancestors[i], amt)) {
                totalToAncestors += amt;
                emit AncestorPaid(address(token), ancestors[i], i + 1, amt);
            } else {
                toHolder += amt;
            }
        }

        // Send holder — strict.
        if (toHolder > 0) {
            if (!_safeTransfer(token, holder, toHolder)) revert TransferFailed();
        }

        holderReleasedToken[address(token)] += toHolder;
        ancestorReleasedToken[address(token)] += totalToAncestors;
        treasuryReleasedToken[address(token)] += toTreasury;

        emit ReleasedERC20(
            msg.sender, address(token), holder, treasuryAddr, toHolder, totalToAncestors, toTreasury
        );
    }

    /// @notice Pure helper computing the 79/20/1 split + geometric
    ///         ancestor cascade for a given balance and chain length.
    ///         Returned `toHolder` already includes the geometric
    ///         remainder (e.g. shallow chains, depth-25 tail dust).
    ///         Reverting-ancestor fallthrough is layered on top by
    ///         the calling release function.
    function _computeSplit(uint256 bal, uint256 ancestorCount)
        internal
        pure
        returns (uint256 toHolder, uint256[] memory ancestorAmounts, uint256 toTreasury)
    {
        toTreasury = (bal * TREASURY_BPS) / 10000;
        toHolder = (bal * HOLDER_BPS) / 10000;
        uint256 ancestorPool = bal - toTreasury - toHolder;

        ancestorAmounts = new uint256[](ancestorCount);
        uint256 pool = ancestorPool;
        for (uint256 i = 0; i < ancestorCount; i++) {
            uint256 slice = (pool * ANCESTOR_LEVEL_BPS) / 10000;
            ancestorAmounts[i] = slice;
            pool -= slice;
        }
        // Any leftover (geometric tail or empty chain) falls to holder.
        toHolder += pool;
    }

    /// @dev Low-level ERC-20 transfer compatible with non-standard
    ///      tokens (missing or non-bool return value). Returns false
    ///      on any failure instead of reverting, so callers can
    ///      cascade the slice to the holder leg.
    function _safeTransfer(IERC20 token, address to, uint256 amount) internal returns (bool) {
        (bool callOk, bytes memory data) =
            address(token).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!callOk) return false;
        if (data.length == 0) return true;
        if (data.length == 32) return abi.decode(data, (bool));
        return false;
    }
}
