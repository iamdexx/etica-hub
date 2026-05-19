// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Burnable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Burnable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EticaResearchRoyaltySplitter} from "./EticaResearchRoyaltySplitter.sol";
import {EticaResearchNFTMetadata} from "./EticaResearchNFTMetadata.sol";

/// @title EticaResearchNFT
/// @notice Permanent on-chain publication record for biomedical-research
///         discoveries produced by the EticaLabs Autopilot pipeline. One
///         NFT per published research branch. Each NFT carries the entire
///         scientific record in contract storage and renders itself
///         entirely on chain via a data-URI {tokenURI}: no IPFS pin, no
///         CDN, no off-chain dependency. Marketplaces (OpenSea, Blur,
///         Magic Eden), wallets (MetaMask, Rabby), and the EticaHub
///         explorer all render the research record inline.
///
/// @dev    DESIGN INVARIANT — ZERO ADMIN POWER OVER MINTED NFTS.
///
///         This contract is deliberately immutable post-deploy. There is
///         no upgrade path, no owner, no admin role, no pause, no
///         _adminBurn, no transfer override, no royalty re-target. The
///         only privileged write surface is {claim}, and the only
///         "authority" gating claims is the constant {ATTESTOR} address
///         set in the constructor — that address can sign mint
///         authorizations but it cannot revoke, transfer, freeze, or
///         touch a single existing NFT.
///
///         If the operator wallet that holds the {ATTESTOR} key is
///         compromised, the worst an attacker can do is mint
///         visibly-junk NFTs into existence by signing fake claim
///         payloads. They CANNOT:
///           - Revoke or burn any existing NFT (only the owner can burn).
///           - Transfer any existing NFT (standard ERC-721 transfer rules).
///           - Change any token's metadata (Discovery is set once in
///             {claim} and never written again).
///           - Redirect any token's royalty receiver address (the
///             per-token splitter is deployed at {claim} time via CREATE2
///             with the tokenId as salt, and {royaltyInfo} reads that
///             immutable mapping; no setter exists).
///           - Pause transfers or trading.
///           - Upgrade this contract.
///
///         The ERC-2981 royalty receiver per token is the per-token
///         {EticaResearchRoyaltySplitter} address — immutable per
///         token — which forwards 79% to the **current** NFT holder
///         (resolved at release time via {ownerOf}), 20% to the
///         ancestor chain (geometric 80/20 cascade up to depth 25,
///         resolved by walking {parentBranchHashOf} +
///         {tokenIdOfBranch} at release time), and 1% to the
///         EticaHub treasury. Selling the NFT therefore transfers
///         the secondary-market royalty stream to the buyer, which
///         is what makes the in-app /labs/market listing valuable.
///         The original discoverer's address is permanently recorded
///         in {submitterOf} for attribution / provenance only — it
///         does not gate any payout.
///
/// @dev    CLAIM-AND-MINT FLOW
///
///         1. The EticaLabs Autopilot detects a winning candidate
///            (score >= branch threshold) on a research-goal branch.
///         2. The off-chain worker constructs a {ClaimPayload} containing
///            the entire scientific record (parent goal title, sequence,
///            analysis, score, iterations, branch goal id, submitter,
///            exclusivity & expiry timestamps) and signs the EIP-712
///            digest with the {ATTESTOR} private key.
///         3. The result is announced on the public lab feed with a
///            "Claim this research" button at /labs/research/<branchGoalId>.
///         4. The original submitter calls {claim} during the
///            exclusive window (default 7 days from discovery) with
///            the payload + signature. They pay EGAZ gas. The contract
///            verifies the signature, stores the Discovery, and mints
///            the NFT to them.
///         5. If they do NOT claim within the window, the research is
///            **abandoned**. After `exclusiveUntil` anyone can call
///            {claim}, but the contract force-mints the NFT to the
///            immutable {treasury} address (msg.sender is ignored).
///            A cron / community member pays gas to settle; treasury
///            ends up as the first holder and may then list on
///            /labs/market to forward the royalty stream to a buyer.
///
///         The contract does NOT pay for or subsidize claims. Treasury
///         bears zero recurring infrastructure cost — IPFS pinning,
///         CDN bandwidth, and gas sponsorship are all eliminated by
///         design. The research record lives in EticaHub chain state
///         forever.
contract EticaResearchNFT is ERC721, ERC721Burnable, EIP712, IERC2981 {
    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error AttestorZero();
    error TreasuryZero();
    error InvalidSignature();
    error AttestationExpired();
    error BranchAlreadyClaimed();
    error SubmitterOnlyDuringExclusive();
    error ScoreTooHigh();
    error EmptyBranchId();
    error EmptyParentGoal();
    error EmptySequence();
    error SubmitterZero();
    error InsufficientMintFee(uint256 required, uint256 provided);
    error FeeTransferFailed();
    error RefundFailed();

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    /// @notice Emitted once per research record when a discovery is minted.
    /// @param  tokenId       The new NFT id.
    /// @param  branchGoalId  Off-chain branch-goal identifier; unique
    ///                       per minted research record (replay-prevented).
    /// @param  claimedBy     The wallet the NFT was minted to (==
    ///                       owner of the NFT at mint time). During
    ///                       the exclusive window this is the
    ///                       discoverer; after the window closes it
    ///                       is forced to be the treasury.
    /// @param  submitter     The original research-goal submitter —
    ///                       permanent attribution recorded in
    ///                       {submitterOf}. Royalties flow to whichever
    ///                       wallet is the **current** NFT holder at
    ///                       release() time, not to this address.
    /// @param  score         Score in basis points (0..10000), where
    ///                       10000 == 1.00. Branch threshold is set
    ///                       off-chain by the autopilot.
    event DiscoveryClaimed(
        uint256 indexed tokenId,
        bytes32 indexed branchGoalIdHash,
        address indexed claimedBy,
        address submitter,
        uint256 score,
        uint256 mintFeeWei,
        string branchGoalId
    );

    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------

    /// @notice Royalty in basis points returned by {royaltyInfo}. 500 = 5%.
    /// @dev    Immutable on deploy; cannot be changed by anyone, ever.
    uint96 public constant ROYALTY_BPS = 500;

    /// @notice Score is reported in basis points (0..10000) so it can
    ///         be rendered as a decimal in {tokenURI} without floats.
    uint256 private constant SCORE_DENOM = 10000;

    /// @notice EIP-712 typehash for {ClaimPayload}. The trailing
    ///         `parentBranchGoalId` field carries the parent research
    ///         branch's off-chain identifier so the ancestor cascade
    ///         on the per-token splitter can walk up the chain at
    ///         release time. Empty string == root research (no parent).
    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "ClaimPayload(string parentGoalTitle,string sequence,string analysis,uint256 score,uint256 iterations,string branchGoalId,address submitter,uint64 expiresAt,uint64 exclusiveUntil,string parentBranchGoalId)"
    );

    /// @notice Maximum depth the ancestor cascade walks. Capped to
    ///         bound the gas of {getAncestorHolders} / release calls.
    uint256 public constant MAX_ANCESTOR_DEPTH = 25;

    // ---------------------------------------------------------------
    // Immutable storage (set once in constructor; never written again)
    // ---------------------------------------------------------------

    /// @notice The single attestor address that can sign claim payloads.
    ///         Set in the constructor and never writable again. If this
    ///         key is compromised, deploy a v2 of this contract — the
    ///         old contract keeps its existing NFTs frozen forever.
    address public immutable ATTESTOR;

    /// @notice The immutable EticaHub treasury address that receives
    ///         the 1% (of sale price) treasury slice of every secondary
    ///         market royalty. Read by every per-token splitter at
    ///         release time. Cannot be changed by anyone, ever.
    address public immutable treasury;

    /// @notice External base URL used to populate `external_url` and
    ///         `animation_url` in {tokenURI}. Set once at deploy; the
    ///         host can be moved by re-deploying a v2 — existing NFTs
    ///         retain whatever URL was minted with them, but since the
    ///         JSON is produced at read time the URL field tracks the
    ///         contract's immutable value (not per-token).
    string public BASE_URL;

    /// @notice Flat per-mint EGAZ fee charged on every researcher
    ///         claim, in wei. Split 79/20/1 (holder / ancestor cascade
    ///         / treasury) along with the score-indexed slice. Constant
    ///         per contract instance — baked in at deploy and never
    ///         writable. This is the "treasury benefit" tax on every
    ///         published research record: even a minimum-score record
    ///         pays at least this amount.
    /// @dev    Waived (skipped) when the post-7d auto-forfeit path
    ///         force-mints to the treasury — treasury paying itself
    ///         is pointless and would brick the abandoned-record rail.
    uint256 public immutable BASE_MINT_FEE_WEI;

    /// @notice Cap on the score-indexed slice of the per-mint EGAZ
    ///         fee, in wei. Constant per contract instance. Actual
    ///         score-indexed fee = (MAX_SCORE_MINT_FEE_WEI * score)
    ///         / 10000, so a score-1.0 record pays this full cap and
    ///         a score-0.5 record pays half. Higher score = higher fee.
    /// @dev    Waived (skipped) on post-7d treasury auto-forfeit
    ///         for the same reason as BASE_MINT_FEE_WEI.
    uint256 public immutable MAX_SCORE_MINT_FEE_WEI;

    // ---------------------------------------------------------------
    // Mutable storage (per token, but never overwritten)
    // ---------------------------------------------------------------

    /// @notice The complete on-chain scientific record for a token.
    ///         Written exactly once, in {claim}. Never updated.
    struct Discovery {
        string parentGoalTitle;
        string sequence;
        string analysis;
        uint256 score; // basis points (0..10000)
        uint256 iterations;
        string branchGoalId;
        address submitter; // original discoverer; attribution-only
        uint64 discoveredAt; // == block.timestamp at mint
        uint64 blockNumber; // == block.number at mint
    }

    /// @notice Permanent research record for every minted token. Set
    ///         once in {claim}; ERC-721 transfers do not alter it.
    mapping(uint256 => Discovery) public discoveryOf;

    /// @notice Hash of the parent branch-goal id for each minted token.
    ///         Empty (== bytes32(0)) for root research records (no
    ///         parent). Used by the splitter to walk the ancestor
    ///         chain via {tokenIdOfBranch} at release time.
    /// @dev    The raw string is not stored on-chain (only the hash);
    ///         this matches the {branchClaimed} / {tokenIdOfBranch}
    ///         convention and saves storage. The raw value is
    ///         emitted in {DiscoveryClaimed} for off-chain consumers.
    mapping(uint256 => bytes32) public parentBranchHashOf;

    /// @notice Replay guard for branch-goal ids. Set true the first
    ///         time a branchGoalId is claimed; rejects every subsequent
    ///         claim with the same id.
    mapping(bytes32 => bool) public branchClaimed;

    /// @notice Token id of the (single) NFT minted for a given branch
    ///         goal hash. 0 means unclaimed. Token ids are 1-indexed.
    mapping(bytes32 => uint256) public tokenIdOfBranch;

    /// @notice Per-token CREATE2 splitter contract. Deployed once at
    ///         {claim} time. Acts as the ERC-2981 royalty receiver
    ///         for that tokenId. Holds funds in isolation per-token.
    mapping(uint256 => address) public splitterOf;

    uint256 private _nextId;

    // ---------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------

    /// @param attestor_              The EticaLabs Autopilot attestor
    ///                               address. Signs ClaimPayloads
    ///                               off-chain. Has zero power over
    ///                               already-minted NFTs.
    /// @param treasury_              EticaHub treasury address. Receives
    ///                               1% of every mint fee AND 1% of
    ///                               every secondary-market royalty
    ///                               (= 0.05% of sale price). Immutable
    ///                               post-deploy.
    /// @param baseUrl_               Base URL for external links rendered
    ///                               into token JSON (e.g.
    ///                               "https://eticahub.com").
    /// @param baseMintFeeWei_        Flat EGAZ fee charged on every
    ///                               researcher claim, paid to treasury.
    ///                               Zero is permitted (no flat fee).
    /// @param maxScoreMintFeeWei_    Cap on the score-indexed EGAZ slice
    ///                               of the per-mint fee; actual
    ///                               score-indexed fee scales linearly
    ///                               with the candidate score (basis
    ///                               points) up to this cap. Zero is
    ///                               permitted (no score-indexed fee).
    constructor(
        address attestor_,
        address treasury_,
        string memory baseUrl_,
        uint256 baseMintFeeWei_,
        uint256 maxScoreMintFeeWei_
    ) ERC721("EticaResearch", "RES") EIP712("EticaResearchNFT", "1") {
        if (attestor_ == address(0)) revert AttestorZero();
        if (treasury_ == address(0)) revert TreasuryZero();
        ATTESTOR = attestor_;
        treasury = treasury_;
        BASE_URL = baseUrl_;
        BASE_MINT_FEE_WEI = baseMintFeeWei_;
        MAX_SCORE_MINT_FEE_WEI = maxScoreMintFeeWei_;
    }

    // ---------------------------------------------------------------
    // Public claim entrypoint
    // ---------------------------------------------------------------

    /// @notice Mint the NFT for a discovery, paying EGAZ gas plus the
    ///         per-mint fee. The fee is split 79/20/1 (holder /
    ///         ancestor cascade / treasury) at mint time:
    ///           - 79% returns to the NFT recipient (= depth-0
    ///             "current holder");
    ///           - 20% cascades up the ancestor chain geometrically
    ///             (80/20 per level, depth-25 cap), resolved by
    ///             walking `parentBranchHashOf` + `tokenIdOfBranch`
    ///             from the new token upward;
    ///           - 1% goes to the immutable {treasury}.
    ///         Any geometric remainder (and any reverting-ancestor
    ///         slice) falls through to the holder leg, never to
    ///         treasury. Root research records (empty
    ///         `parentBranchGoalId`) have no ancestors and the 20%
    ///         slice falls entirely to the holder.
    /// @dev    During the exclusive window
    ///         (`block.timestamp <= payload.exclusiveUntil`), only
    ///         `payload.submitter` may call — and the NFT mints to
    ///         them. The caller must attach
    ///         `BASE_MINT_FEE_WEI + (MAX_SCORE_MINT_FEE_WEI * score) / 10000`
    ///         in `msg.value`; the contract performs the 79/20/1 split
    ///         in the same transaction and refunds any excess back to
    ///         `msg.sender`.
    ///
    ///         Afterwards the research record is considered
    ///         **abandoned**: anyone may call to settle the discovery,
    ///         but the NFT is force-minted to the immutable {treasury}
    ///         address (msg.sender is ignored for the recipient). The
    ///         per-mint fee is **waived** on this auto-forfeit path —
    ///         the treasury paying itself would be pointless and would
    ///         brick the abandoned-research rail. This enforces
    ///         "unclaimed research auto-forfeits to treasury" at the
    ///         contract layer — no admin path, no race, no requirement
    ///         that anyone in particular call it.
    ///
    ///         Provenance is preserved either way: `submitterOf`
    ///         (and the tokenURI "Original discoverer" field) is
    ///         always set to `payload.submitter` regardless of who
    ///         actually paid gas to mint.
    /// @param  payload  The full Discovery record + window timestamps.
    /// @param  sig      EIP-712 signature from {ATTESTOR} over
    ///                  `payload`.
    /// @return tokenId  Newly minted token id (1-indexed).
    function claim(ClaimPayload calldata payload, bytes calldata sig)
        external
        payable
        returns (uint256 tokenId)
    {
        // Cheap field-level sanity gates before doing expensive sig recovery.
        if (bytes(payload.branchGoalId).length == 0) revert EmptyBranchId();
        if (bytes(payload.parentGoalTitle).length == 0) revert EmptyParentGoal();
        if (bytes(payload.sequence).length == 0) revert EmptySequence();
        if (payload.submitter == address(0)) revert SubmitterZero();
        if (payload.score > SCORE_DENOM) revert ScoreTooHigh();
        if (block.timestamp > payload.expiresAt) revert AttestationExpired();

        bytes32 branchHash = keccak256(bytes(payload.branchGoalId));
        if (branchClaimed[branchHash]) revert BranchAlreadyClaimed();

        // Exclusive window: discoverer-only claim. After the window
        // closes the research record is treated as abandoned and the
        // recipient is forced to the treasury (resolved below at mint
        // time).
        bool exclusive = block.timestamp <= payload.exclusiveUntil;
        if (exclusive && msg.sender != payload.submitter) {
            revert SubmitterOnlyDuringExclusive();
        }

        // EIP-712 signature verification — must be the immutable attestor.
        // Wrapped in a scope block so the digest / recovered locals
        // are released before the heavier mint + fee + emit phase
        // below, keeping us under the Solidity stack-slot limit.
        {
            bytes32 structHash = _hashClaimPayload(payload);
            bytes32 digest = _hashTypedDataV4(structHash);
            address recovered = ECDSA.recover(digest, sig);
            if (recovered != ATTESTOR) revert InvalidSignature();
        }

        // Mark claimed and mint.
        branchClaimed[branchHash] = true;
        unchecked {
            tokenId = ++_nextId;
        }
        tokenIdOfBranch[branchHash] = tokenId;

        discoveryOf[tokenId] = Discovery({
            parentGoalTitle: payload.parentGoalTitle,
            sequence: payload.sequence,
            analysis: payload.analysis,
            score: payload.score,
            iterations: payload.iterations,
            branchGoalId: payload.branchGoalId,
            submitter: payload.submitter,
            discoveredAt: uint64(block.timestamp),
            blockNumber: uint64(block.number)
        });

        // Record the parent branch-goal hash for the ancestor cascade.
        // Empty parentBranchGoalId == root research record; the hash
        // remains bytes32(0) which short-circuits the chain walk.
        if (bytes(payload.parentBranchGoalId).length > 0) {
            parentBranchHashOf[tokenId] = keccak256(bytes(payload.parentBranchGoalId));
        }

        // Deploy the per-token CREATE2 royalty splitter. Salt is the
        // tokenId; combined with the (address(this), tokenId)
        // constructor args this gives a unique, predictable address
        // for every minted record. The splitter accepts marketplace
        // value via {receive} (native) or bare ERC-20 transfers, and
        // forwards 79/20/1 (current-holder / ancestor cascade /
        // treasury) on permissionless {release} / {releaseERC20} calls.
        EticaResearchRoyaltySplitter splitter =
            new EticaResearchRoyaltySplitter{salt: bytes32(tokenId)}(address(this), tokenId);
        splitterOf[tokenId] = address(splitter);

        // During the exclusive window the discoverer mints to
        // themselves (the prior `msg.sender == submitter` check
        // already enforced this). After it closes, the research record
        // is abandoned and the NFT is force-minted to the treasury
        // regardless of who paid gas to trigger the call.
        address recipient = exclusive ? msg.sender : treasury;
        _safeMint(recipient, tokenId);

        // Settle the per-mint EGAZ fee (or waiver) and surface the
        // amount that ended up flowing to the treasury so it can be
        // emitted in the event below.
        uint256 mintFeeWei = _settleMintFee(recipient, payload.score, tokenId);

        emit DiscoveryClaimed(
            tokenId,
            branchHash,
            recipient,
            payload.submitter,
            payload.score,
            mintFeeWei,
            payload.branchGoalId
        );
    }

    /// @notice Internal fee accounting helper for {claim}. Splits the
    ///         BASE + score-indexed EGAZ fee 79/20/1 across the new
    ///         holder, the ancestor chain (geometric 80/20 cascade,
    ///         depth-25 cap), and the treasury, then refunds any
    ///         overpayment to msg.sender. Waives the entire fee
    ///         (and refunds all msg.value) when the recipient is the
    ///         treasury itself on the post-7d auto-forfeit path.
    /// @dev    Pulled out of {claim} to keep that function under the
    ///         Solidity stack-slot limit (16 locals).
    function _settleMintFee(address recipient, uint256 score, uint256 tokenId)
        internal
        returns (uint256 feeWei)
    {
        if (recipient == treasury) {
            // Post-7d auto-forfeit. Treasury paying itself is pointless
            // and would brick the abandoned-research rail; the fee is
            // waived. Any value accidentally sent is fully refunded
            // to the gas-payer so they aren't griefed for triggering
            // the auto-mint.
            if (msg.value > 0) {
                (bool ok,) = payable(msg.sender).call{value: msg.value}("");
                if (!ok) revert RefundFailed();
            }
            return 0;
        }

        feeWei = BASE_MINT_FEE_WEI + (MAX_SCORE_MINT_FEE_WEI * score) / SCORE_DENOM;
        if (msg.value < feeWei) revert InsufficientMintFee(feeWei, msg.value);
        if (feeWei > 0) {
            _cascadePayout(feeWei, recipient, tokenId);
        }
        uint256 refund = msg.value - feeWei;
        if (refund > 0) {
            (bool ok,) = payable(msg.sender).call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice Split `amount` 79/20/1 (holder / ancestor cascade /
    ///         treasury) and forward each slice in-line. Used by
    ///         {_settleMintFee} so mints respect the same uniform
    ///         cascade rule as secondary-sale royalties.
    /// @dev    Reverting-ancestor wallets fall through to the holder
    ///         leg, never to treasury. Treasury and holder sends are
    ///         strict (revert on failure) to preserve the invariant
    ///         that treasury is always exactly 1% and the holder is
    ///         always paid.
    function _cascadePayout(uint256 amount, address holder, uint256 tokenId) internal {
        uint256 toTreasury = amount / 100;
        uint256 toHolder = (amount * 79) / 100;
        uint256 ancestorPool = amount - toTreasury - toHolder;

        address[] memory ancestors = _walkAncestors(tokenId);
        uint256[] memory amounts = new uint256[](ancestors.length);
        uint256 pool = ancestorPool;
        for (uint256 i = 0; i < ancestors.length; i++) {
            uint256 slice = (pool * 8000) / 10000;
            amounts[i] = slice;
            pool -= slice;
        }
        // Geometric remainder + shallow-chain leftover falls to holder.
        toHolder += pool;

        // Treasury — strict.
        if (toTreasury > 0) {
            (bool ok,) = payable(treasury).call{value: toTreasury}("");
            if (!ok) revert FeeTransferFailed();
        }

        // Ancestors — failure falls through to holder.
        for (uint256 i = 0; i < ancestors.length; i++) {
            uint256 amt = amounts[i];
            if (amt == 0) continue;
            (bool ok,) = payable(ancestors[i]).call{value: amt}("");
            if (!ok) toHolder += amt;
        }

        // Holder — strict.
        if (toHolder > 0) {
            (bool ok,) = payable(holder).call{value: toHolder}("");
            if (!ok) revert FeeTransferFailed();
        }
    }

    /// @notice Walk the ancestor chain for `startTokenId`, returning
    ///         the current holder addresses up to {MAX_ANCESTOR_DEPTH}
    ///         levels. The returned array is depth-ordered: index 0
    ///         is the immediate parent's current holder, index 1 the
    ///         grandparent, etc. Array length is the actual resolved
    ///         depth (0 for root research records).
    /// @dev    The walk stops at the first parent that either has no
    ///         registered branch hash (= root), is not yet minted
    ///         (= unminted parent), or has been burned (ownerOf
    ///         returns address(0)). This means the cascade does not
    ///         skip over gaps in the chain: a burned ancestor severs
    ///         the cascade above for descendants. By design, no admin
    ///         recovery path exists.
    function _walkAncestors(uint256 startTokenId) internal view returns (address[] memory holders) {
        holders = new address[](MAX_ANCESTOR_DEPTH);
        uint256 current = startTokenId;
        uint256 count = 0;
        for (uint256 i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
            bytes32 ph = parentBranchHashOf[current];
            if (ph == bytes32(0)) break;
            uint256 parentId = tokenIdOfBranch[ph];
            if (parentId == 0) break;
            address o = _ownerOf(parentId);
            if (o == address(0)) break;
            holders[count] = o;
            count++;
            current = parentId;
        }
        // Shrink to actual count.
        assembly {
            mstore(holders, count)
        }
    }

    /// @notice External view delegating to {_walkAncestors}. Read by
    ///         the per-token splitter at release time to resolve the
    ///         current ancestor chain. Returns an empty array for
    ///         root research records and for any chain whose first
    ///         parent is not yet minted.
    function getAncestorHolders(uint256 tokenId) external view returns (address[] memory holders) {
        return _walkAncestors(tokenId);
    }

    /// @notice Convenience view: returns the tokenId of `tokenId`'s
    ///         immediate parent, or 0 if `tokenId` is a root research
    ///         record or its parent has not been minted yet.
    function parentTokenIdOf(uint256 tokenId) external view returns (uint256) {
        bytes32 ph = parentBranchHashOf[tokenId];
        if (ph == bytes32(0)) return 0;
        return tokenIdOfBranch[ph];
    }

    /// @notice Convenience helper for off-chain signers. Returns the
    ///         EIP-712 digest a {ClaimPayload} must be signed against.
    function claimDigest(ClaimPayload calldata payload) external view returns (bytes32) {
        return _hashTypedDataV4(_hashClaimPayload(payload));
    }

    /// @notice Convenience getter so off-chain UIs can quickly check
    ///         whether a branch already has a minted NFT.
    function isBranchClaimed(string calldata branchGoalId) external view returns (bool) {
        return branchClaimed[keccak256(bytes(branchGoalId))];
    }

    /// @notice Per-token original-discoverer accessor. The splitter
    ///         no longer reads this for payout (it uses {ownerOf}
    ///         instead, so royalty follows ownership), but the value
    ///         is preserved here for permanent attribution — it is
    ///         shown in the tokenURI's "Original discoverer" field
    ///         and exposed for off-chain explorers / marketplaces.
    function submitterOf(uint256 tokenId) external view returns (address) {
        return discoveryOf[tokenId].submitter;
    }

    // ---------------------------------------------------------------
    // ERC-2981
    // ---------------------------------------------------------------

    /// @inheritdoc IERC2981
    /// @dev    Per-token receiver is the immutable splitter contract
    ///         deployed at {claim} time. The splitter forwards 79%
    ///         of incoming value to the **current** NFT holder
    ///         (resolved at release time), 20% to the ancestor chain
    ///         (geometric 80/20 cascade, depth-25 cap), and 1% to the
    ///         EticaHub treasury. The receiver address (the splitter)
    ///         cannot be retargeted by any party; the 79% leg
    ///         naturally tracks ownership via ERC-721 transfers.
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external
        view
        override
        returns (address receiver, uint256 royaltyAmount)
    {
        // For non-existent tokens, returns zero address per ERC-2981
        // convention; callers should check via {ownerOf} first.
        receiver = splitterOf[tokenId];
        royaltyAmount = (salePrice * ROYALTY_BPS) / 10000;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC721, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC2981).interfaceId || super.supportsInterface(interfaceId);
    }

    // ---------------------------------------------------------------
    // On-chain tokenURI
    // ---------------------------------------------------------------

    /// @notice Returns a fully self-contained data-URI JSON blob — no
    ///         IPFS, no CDN. The `description` field embeds the entire
    ///         research record in markdown so every marketplace,
    ///         wallet, and explorer renders the scientific content
    ///         inline.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Discovery storage s = discoveryOf[tokenId];
        EticaResearchNFTMetadata.Discovery memory d = EticaResearchNFTMetadata.Discovery({
            parentGoalTitle: s.parentGoalTitle,
            sequence: s.sequence,
            analysis: s.analysis,
            score: s.score,
            iterations: s.iterations,
            branchGoalId: s.branchGoalId,
            submitter: s.submitter,
            discoveredAt: s.discoveredAt,
            blockNumber: s.blockNumber
        });
        return EticaResearchNFTMetadata.buildTokenURI(tokenId, d, BASE_URL);
    }

    // ---------------------------------------------------------------
    // Internal: claim payload struct + hash
    // ---------------------------------------------------------------

    /// @notice Payload signed by the attestor and submitted by the user.
    /// @dev    `parentBranchGoalId` is the off-chain id of the parent
    ///         research branch. Empty string == root research record
    ///         (no parent). Hashed and stored in
    ///         {parentBranchHashOf}; never persisted as a raw string
    ///         on-chain.
    struct ClaimPayload {
        string parentGoalTitle;
        string sequence;
        string analysis;
        uint256 score; // basis points (0..10000)
        uint256 iterations;
        string branchGoalId;
        address submitter;
        uint64 expiresAt;
        uint64 exclusiveUntil;
        string parentBranchGoalId;
    }

    function _hashClaimPayload(ClaimPayload calldata p) internal pure returns (bytes32) {
        return keccak256(
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
    }
}
