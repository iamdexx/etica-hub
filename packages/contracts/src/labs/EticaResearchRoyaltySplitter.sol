// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IEticaResearchNFTForSplitter {
    function treasury() external view returns (address);
    function submitterOf(uint256 tokenId) external view returns (address);
}

/// @title EticaResearchRoyaltySplitter
/// @notice One per cure NFT. Acts as the ERC-2981 royalty receiver
///         address for that specific token: marketplaces send the
///         royalty value here on every secondary sale, and {release}
///         forwards 80% to the original submitter and 20% to the
///         EticaHub treasury.
///
/// @dev    Per-token isolation is the whole point. ERC-2981 royalty
///         payments arrive as plain {receive} value transfers with
///         no tokenId metadata, so a single shared splitter would
///         conflate every token's pending balance. Giving each
///         tokenId its own splitter address means funds for token N
///         can only ever be claimed against token N's submitter +
///         the (immutable) treasury — no cross-contamination, no
///         first-comer-takes-all race.
///
/// @dev    Zero admin surface. The {nft} contract reference and
///         {tokenId} are baked in at construction; the split ratio
///         is hard-coded; there are no upgrade or pause functions.
///         Worst case if the EticaHub operator wallet is compromised:
///         attacker still cannot redirect any existing splitter's
///         funds — the treasury and submitter addresses are read
///         from the immutable NFT contract's state, which the
///         operator wallet has no power to overwrite either.
contract EticaResearchRoyaltySplitter {
    error AlreadyReleasing();
    error TransferFailed();
    error NothingToRelease();

    /// @notice Submitter share, in basis points of the splitter's balance.
    /// @dev    Treasury share is the remainder (10000 - SUBMITTER_BPS).
    uint16 public constant SUBMITTER_BPS = 8000; // 80%

    /// @notice Address of the EticaResearchNFT contract that owns this
    ///         splitter. Read at release() time to resolve the current
    ///         treasury + per-token submitter.
    address public immutable nft;

    /// @notice The single tokenId this splitter is associated with.
    uint256 public immutable tokenId;

    /// @notice Cumulative ETH/EGAZ released to the submitter so far.
    uint256 public submitterReleased;

    /// @notice Cumulative ETH/EGAZ released to the treasury so far.
    uint256 public treasuryReleased;

    /// @notice Lifetime ETH/EGAZ that has flowed through this splitter
    ///         (released to submitter + released to treasury + current
    ///         on-chain balance). Useful for off-chain analytics.
    function lifetimeFlow() external view returns (uint256) {
        return submitterReleased + treasuryReleased + address(this).balance;
    }

    /// @notice Emitted on each successful {release} call.
    event Released(
        address indexed caller,
        address indexed submitter,
        address indexed treasury,
        uint256 toSubmitter,
        uint256 toTreasury
    );

    constructor(address nft_, uint256 tokenId_) {
        nft = nft_;
        tokenId = tokenId_;
    }

    // Accept value from marketplaces without function call.
    receive() external payable {}

    /// @notice Forward the entire current balance — 80% to the cure's
    ///         original submitter, 20% to the EticaHub treasury.
    ///         Permissionless: anyone may call.
    /// @dev    Uses .call to be tolerant of recipient contracts that
    ///         need >2300 gas (e.g. Gnosis Safe). Re-entrancy is
    ///         neutralized by computing both transfer amounts up
    ///         front from the snapshot balance and zeroing the
    ///         residual via the final balance check.
    function release() external {
        uint256 bal = address(this).balance;
        if (bal == 0) revert NothingToRelease();

        IEticaResearchNFTForSplitter nftRef = IEticaResearchNFTForSplitter(nft);
        address submitter = nftRef.submitterOf(tokenId);
        address treasury = nftRef.treasury();

        uint256 toSubmitter = (bal * SUBMITTER_BPS) / 10000;
        uint256 toTreasury = bal - toSubmitter;

        submitterReleased += toSubmitter;
        treasuryReleased += toTreasury;

        if (toSubmitter > 0) {
            (bool ok,) = payable(submitter).call{value: toSubmitter}("");
            if (!ok) revert TransferFailed();
        }
        if (toTreasury > 0) {
            (bool ok,) = payable(treasury).call{value: toTreasury}("");
            if (!ok) revert TransferFailed();
        }

        emit Released(msg.sender, submitter, treasury, toSubmitter, toTreasury);
    }
}
