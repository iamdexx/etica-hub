// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Burnable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Burnable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

import {EticaResearchRoyaltySplitter} from "./EticaResearchRoyaltySplitter.sol";

/// @title EticaResearchNFT
/// @notice Permanent on-chain publication record for biomedical-research
///         discoveries produced by the EticaLabs Autopilot pipeline. One
///         NFT per published "cure" branch. Each NFT carries the entire
///         scientific record in contract storage and renders itself
///         entirely on chain via a data-URI {tokenURI}: no IPFS pin, no
///         CDN, no off-chain dependency. Marketplaces (OpenSea, Blur,
///         Magic Eden), wallets (MetaMask, Rabby), and the EticaHub
///         explorer all render the cure inline.
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
///         token — which forwards 80% to the **current** NFT holder
///         (resolved at release time via {ownerOf}) and 20% to the
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
///         3. The cure is announced on the public lab feed with a
///            "Claim this discovery" button at /labs/cure/<branchGoalId>.
///         4. The original submitter calls {claim} during the
///            exclusive window (default 7 days from discovery) with
///            the payload + signature. They pay EGAZ gas. The contract
///            verifies the signature, stores the Discovery, and mints
///            the NFT to them.
///         5. If they do NOT claim within the window, the cure is
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
///         design. The cure record lives in EticaHub chain state
///         forever.
contract EticaResearchNFT is ERC721, ERC721Burnable, EIP712, IERC2981 {
    using Strings for uint256;
    using Strings for address;

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

    /// @notice Emitted once per cure when a discovery is minted.
    /// @param  tokenId       The new NFT id.
    /// @param  branchGoalId  Off-chain branch-goal identifier; unique
    ///                       per minted cure (replay-prevented).
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

    /// @notice EIP-712 typehash for {ClaimPayload}.
    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "ClaimPayload(string parentGoalTitle,string sequence,string analysis,uint256 score,uint256 iterations,string branchGoalId,address submitter,uint64 expiresAt,uint64 exclusiveUntil)"
    );

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

    /// @notice Flat per-mint EGAZ fee paid to the treasury on every
    ///         researcher claim, in wei. Constant per contract
    ///         instance — baked in at deploy and never writable.
    ///         This is the "treasury benefit" tax on every published
    ///         cure: even a minimum-score cure pays at least this
    ///         amount.
    /// @dev    Waived (skipped) when the post-7d auto-forfeit path
    ///         force-mints to the treasury — treasury paying itself
    ///         is pointless and would brick the abandoned-cure rail.
    uint256 public immutable BASE_MINT_FEE_WEI;

    /// @notice Cap on the score-indexed slice of the per-mint EGAZ
    ///         fee, in wei. Constant per contract instance. Actual
    ///         score-indexed fee = (MAX_SCORE_MINT_FEE_WEI * score)
    ///         / 10000, so a score-1.0 cure pays this full cap and
    ///         a score-0.5 cure pays half. Higher score = higher fee.
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

    /// @notice Permanent cure record for every minted token. Set once
    ///         in {claim}; ERC-721 transfers do not alter it.
    mapping(uint256 => Discovery) public discoveryOf;

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
    ///                               20% of every secondary-market
    ///                               royalty (= 1% of sale price) AND
    ///                               the per-mint EGAZ fee on every
    ///                               researcher claim. Immutable
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
    ) ERC721("EticaResearch Cure", "CURE") EIP712("EticaResearchNFT", "1") {
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
    ///         per-mint treasury fee.
    /// @dev    During the exclusive window
    ///         (`block.timestamp <= payload.exclusiveUntil`), only
    ///         `payload.submitter` may call — and the NFT mints to
    ///         them. The caller must attach
    ///         `BASE_MINT_FEE_WEI + (MAX_SCORE_MINT_FEE_WEI * score) / 10000`
    ///         in `msg.value`; the contract forwards that to the
    ///         immutable {treasury} address and refunds any excess
    ///         back to `msg.sender`.
    ///
    ///         Afterwards the cure is considered **abandoned**:
    ///         anyone may call to settle the discovery, but the NFT
    ///         is force-minted to the immutable {treasury} address
    ///         (msg.sender is ignored for the recipient). The per-mint
    ///         fee is **waived** on this auto-forfeit path — the
    ///         treasury paying itself would be pointless and would
    ///         brick the abandoned-cure rail. This enforces
    ///         "unclaimed cures auto-forfeit to treasury" at the
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
        // closes the cure is treated as abandoned and the recipient
        // is forced to the treasury (resolved below at mint time).
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

        // Deploy the per-token CREATE2 royalty splitter. Salt is the
        // tokenId; combined with the (address(this), tokenId)
        // constructor args this gives a unique, predictable address
        // for every minted cure. The splitter accepts marketplace
        // value via {receive} (native) or bare ERC-20 transfers, and
        // forwards 80/20 (current-holder/treasury) on permissionless
        // {release} / {releaseERC20} calls.
        EticaResearchRoyaltySplitter splitter =
            new EticaResearchRoyaltySplitter{salt: bytes32(tokenId)}(address(this), tokenId);
        splitterOf[tokenId] = address(splitter);

        // During the exclusive window the discoverer mints to
        // themselves (the prior `msg.sender == submitter` check
        // already enforced this). After it closes, the cure is
        // abandoned and the NFT is force-minted to the treasury
        // regardless of who paid gas to trigger the call.
        address recipient = exclusive ? msg.sender : treasury;
        _safeMint(recipient, tokenId);

        // Settle the per-mint EGAZ fee (or waiver) and surface the
        // amount that ended up flowing to the treasury so it can be
        // emitted in the event below.
        uint256 mintFeeWei = _settleMintFee(recipient, payload.score);

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

    /// @notice Internal fee accounting helper for {claim}. Charges the
    ///         BASE + score-indexed EGAZ fee to the treasury and
    ///         refunds any overpayment to msg.sender when the
    ///         recipient is a researcher; waives the fee entirely
    ///         (and refunds all msg.value) when the recipient is the
    ///         treasury itself on the post-7d auto-forfeit path.
    /// @dev    Pulled out of {claim} to keep that function under the
    ///         Solidity stack-slot limit (16 locals).
    function _settleMintFee(address recipient, uint256 score) internal returns (uint256 feeWei) {
        if (recipient == treasury) {
            // Post-7d auto-forfeit. Treasury paying itself is pointless
            // and would brick the abandoned-cure rail; the fee is
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
            (bool ok,) = payable(treasury).call{value: feeWei}("");
            if (!ok) revert FeeTransferFailed();
        }
        uint256 refund = msg.value - feeWei;
        if (refund > 0) {
            (bool ok,) = payable(msg.sender).call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
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
    ///         deployed at {claim} time. The splitter forwards 80%
    ///         of incoming value to the **current** NFT holder
    ///         (resolved at release time) and 20% to the EticaHub
    ///         treasury. The receiver address (the splitter) cannot
    ///         be retargeted by any party; the 80% leg naturally
    ///         tracks ownership via ERC-721 transfers.
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
    ///         cure record in markdown so every marketplace, wallet,
    ///         and explorer renders the scientific content inline.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Discovery storage d = discoveryOf[tokenId];

        // Build in chunks to avoid Solidity's stack-too-deep limit.
        // Each part is its own memory allocation; we concatenate at
        // the very end into the final data URI.
        bytes memory head = _jsonHead(tokenId, d);
        bytes memory mid = _jsonMid(tokenId, d);
        bytes memory tail = _jsonTail(tokenId, d);
        bytes memory full = bytes.concat(head, mid, tail);

        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(full)));
    }

    function _jsonHead(uint256 tokenId, Discovery storage d) internal view returns (bytes memory) {
        return abi.encodePacked(
            '{"name":"',
            _jsonEscape(_buildName(tokenId, d.parentGoalTitle)),
            '","description":"',
            _jsonEscape(_buildDescription(tokenId, d)),
            '"'
        );
    }

    function _jsonMid(uint256 tokenId, Discovery storage d) internal view returns (bytes memory) {
        return abi.encodePacked(
            ',"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_buildSvg(tokenId, d))),
            '","external_url":"',
            _externalUrl(tokenId),
            '"'
        );
    }

    function _jsonTail(uint256 tokenId, Discovery storage d) internal view returns (bytes memory) {
        return abi.encodePacked(
            ',"animation_url":"', _viewerUrl(tokenId), '","attributes":', _buildAttributes(d), "}"
        );
    }

    function _buildName(uint256 tokenId, string memory parentGoalTitle)
        internal
        pure
        returns (string memory)
    {
        return string(
            abi.encodePacked("EticaResearch Cure #", tokenId.toString(), " - ", parentGoalTitle)
        );
    }

    // ---------------------------------------------------------------
    // Internal: claim payload struct + hash
    // ---------------------------------------------------------------

    /// @notice Payload signed by the attestor and submitted by the user.
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
                p.exclusiveUntil
            )
        );
    }

    // ---------------------------------------------------------------
    // Internal: description, svg, attributes, urls
    // ---------------------------------------------------------------

    function _buildDescription(uint256 tokenId, Discovery storage d)
        internal
        view
        returns (string memory)
    {
        // Split into chunks to keep each abi.encodePacked under the
        // EVM stack limit. Re-merged at return.
        bytes memory a = abi.encodePacked(
            "## Parent goal\n",
            d.parentGoalTitle,
            "\n\n## Sequence\n`",
            d.sequence,
            "`\n\n## Findings\n",
            d.analysis
        );
        bytes memory b = abi.encodePacked(
            "\n\n## Score\n",
            _scoreDecimal(d.score),
            " (",
            d.score.toString(),
            "/10000)\n\n## Iterations\n",
            d.iterations.toString()
        );
        bytes memory c = abi.encodePacked(
            "\n\n## Discovered\n",
            uint256(d.discoveredAt).toString(),
            " UTC (block #",
            uint256(d.blockNumber).toString(),
            ")\n\n## Original submitter\n`",
            d.submitter.toHexString()
        );
        bytes memory e = abi.encodePacked(
            "`\n\n## Branch goal id\n`",
            d.branchGoalId,
            "`\n\n## Reproducibility\nFold the sequence with ESMFold or any equivalent structure-prediction engine to reproduce the predicted 3D structure. Analysis was generated by the EticaLabs Autopilot pipeline; see ",
            _externalUrl(tokenId),
            " for the live structural viewer and parent-goal trail."
        );
        return string(bytes.concat(a, b, c, e));
    }

    function _buildSvg(uint256 tokenId, Discovery storage d) internal view returns (string memory) {
        // Minimal, readable card. ~1KB. Renders parent-goal title,
        // tokenId, score, and a sequence preview. Pure on-chain.
        // Split into chunks to stay below the EVM stack limit.
        string memory seqPreview = _truncate(d.sequence, 40);
        string memory titlePreview = _truncate(d.parentGoalTitle, 60);
        bytes memory svgA = abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" font-family="-apple-system,BlinkMacSystemFont,sans-serif">',
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0b1020"/><stop offset="100%" stop-color="#1a2342"/></linearGradient></defs>',
            '<rect width="800" height="500" fill="url(#g)"/>',
            '<text x="40" y="80" fill="#7fd8ff" font-size="14" letter-spacing="6">ETICARESEARCH CURE</text>',
            '<text x="40" y="130" fill="#fff" font-size="36" font-weight="700">#',
            tokenId.toString(),
            "</text>"
        );
        bytes memory svgB = abi.encodePacked(
            '<text x="40" y="200" fill="#cdd6f4" font-size="22" font-weight="600">',
            _xmlEscape(titlePreview),
            '</text><text x="40" y="280" fill="#7fd8ff" font-size="12" letter-spacing="3">SEQUENCE</text>',
            '<text x="40" y="310" fill="#fff" font-size="18" font-family="monospace">',
            _xmlEscape(seqPreview),
            "</text>"
        );
        bytes memory svgC = abi.encodePacked(
            '<text x="40" y="380" fill="#7fd8ff" font-size="12" letter-spacing="3">SCORE</text>',
            '<text x="40" y="420" fill="#fff" font-size="48" font-weight="700">',
            _scoreDecimal(d.score),
            '</text><text x="600" y="470" fill="#7fd8ff" font-size="12" opacity="0.7">eticahub.com/labs</text>',
            "</svg>"
        );
        return string(bytes.concat(svgA, svgB, svgC));
    }

    function _buildAttributes(Discovery storage d) internal view returns (string memory) {
        bytes memory attrA = abi.encodePacked(
            '[{"trait_type":"Score","value":',
            _scoreDecimal(d.score),
            ',"max_value":1},{"trait_type":"Score (bps)","value":',
            d.score.toString(),
            ',"max_value":10000},{"trait_type":"Iterations","value":',
            d.iterations.toString(),
            "}"
        );
        bytes memory attrB = abi.encodePacked(
            ',{"trait_type":"Sequence length","value":',
            bytes(d.sequence).length.toString(),
            '},{"trait_type":"Parent goal","value":"',
            _jsonEscape(d.parentGoalTitle),
            '"},{"display_type":"date","trait_type":"Discovered","value":',
            uint256(d.discoveredAt).toString(),
            "}]"
        );
        return string(bytes.concat(attrA, attrB));
    }

    function _externalUrl(uint256 tokenId) internal view returns (string memory) {
        return string(abi.encodePacked(BASE_URL, "/labs/cure/", tokenId.toString()));
    }

    function _viewerUrl(uint256 tokenId) internal view returns (string memory) {
        return string(abi.encodePacked(BASE_URL, "/labs/cure/", tokenId.toString(), "/viewer"));
    }

    // ---------------------------------------------------------------
    // Internal: small string helpers
    // ---------------------------------------------------------------

    /// @dev Render a score in basis points as "0.NN" / "0.NNNN".
    function _scoreDecimal(uint256 scoreBps) internal pure returns (string memory) {
        if (scoreBps >= SCORE_DENOM) return "1.00";
        // Format as 0.XXXX (4 fractional digits).
        bytes memory frac = bytes(scoreBps.toString());
        bytes memory padded = new bytes(4);
        uint256 pad = 4 - frac.length;
        for (uint256 i = 0; i < 4; i++) {
            if (i < pad) {
                padded[i] = "0";
            } else {
                padded[i] = frac[i - pad];
            }
        }
        return string(abi.encodePacked("0.", padded));
    }

    function _truncate(string memory s, uint256 maxLen) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length <= maxLen) return s;
        bytes memory out = new bytes(maxLen + 3);
        for (uint256 i = 0; i < maxLen; i++) {
            out[i] = b[i];
        }
        out[maxLen] = ".";
        out[maxLen + 1] = ".";
        out[maxLen + 2] = ".";
        return string(out);
    }

    /// @dev Escape a string for safe embedding in a JSON string literal.
    function _jsonEscape(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        // Upper bound: each input char produces at most 6 output chars (\u00XX).
        bytes memory out = new bytes(b.length * 6);
        uint256 j;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == 0x22) {
                out[j++] = "\\";
                out[j++] = '"';
            } else if (c == 0x5c) {
                out[j++] = "\\";
                out[j++] = "\\";
            } else if (c == 0x0a) {
                out[j++] = "\\";
                out[j++] = "n";
            } else if (c == 0x0d) {
                out[j++] = "\\";
                out[j++] = "r";
            } else if (c == 0x09) {
                out[j++] = "\\";
                out[j++] = "t";
            } else if (uint8(c) < 0x20) {
                // Other control char -> \u00XX
                out[j++] = "\\";
                out[j++] = "u";
                out[j++] = "0";
                out[j++] = "0";
                out[j++] = _hexNibble(uint8(c) >> 4);
                out[j++] = _hexNibble(uint8(c) & 0x0f);
            } else {
                out[j++] = c;
            }
        }
        bytes memory trimmed = new bytes(j);
        for (uint256 i = 0; i < j; i++) {
            trimmed[i] = out[i];
        }
        return string(trimmed);
    }

    /// @dev Escape a string for safe embedding inside an SVG text node.
    function _xmlEscape(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length * 6);
        uint256 j;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == 0x26) {
                out[j++] = "&";
                out[j++] = "a";
                out[j++] = "m";
                out[j++] = "p";
                out[j++] = ";";
            } else if (c == 0x3c) {
                out[j++] = "&";
                out[j++] = "l";
                out[j++] = "t";
                out[j++] = ";";
            } else if (c == 0x3e) {
                out[j++] = "&";
                out[j++] = "g";
                out[j++] = "t";
                out[j++] = ";";
            } else if (c == 0x22) {
                out[j++] = "&";
                out[j++] = "q";
                out[j++] = "u";
                out[j++] = "o";
                out[j++] = "t";
                out[j++] = ";";
            } else if (c == 0x27) {
                out[j++] = "&";
                out[j++] = "a";
                out[j++] = "p";
                out[j++] = "o";
                out[j++] = "s";
                out[j++] = ";";
            } else {
                out[j++] = c;
            }
        }
        bytes memory trimmed = new bytes(j);
        for (uint256 i = 0; i < j; i++) {
            trimmed[i] = out[i];
        }
        return string(trimmed);
    }

    function _hexNibble(uint8 n) private pure returns (bytes1) {
        return bytes1(n < 10 ? n + 0x30 : n - 10 + 0x61);
    }
}
