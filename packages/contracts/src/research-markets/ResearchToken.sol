// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title ResearchToken
/// @notice Plain ERC20Permit launched by EticaResearchMarkets. The singleton
///         router is the sole mint/burn authority — supply only changes via
///         the bonding curve in {EticaResearchMarkets}. There is no owner,
///         no pause, no transfer tax, no blacklist, no upgrade. Mint and
///         burn are restricted to the immutable `market` address so the
///         only price-discovery venue for this token is the protocol's
///         shared pool.
///
/// @dev    Bytecode is deterministic across launches (only constructor
///         strings differ), which lets the launchpad post a single
///         canonical metadata bundle to Sourcify and have every new
///         ResearchToken verify against it on first deploy.
contract ResearchToken is ERC20Permit {
    /// @notice The EticaResearchMarkets singleton that exclusively controls
    ///         this token's supply. Set once at construction and never
    ///         changes.
    address public immutable market;

    /// @notice The wallet that launched this token (research author / submitter).
    ///         Receives the 10% researcher slice of every trade fee.
    address public immutable researcher;

    /// @notice IPFS or HTTPS URI of the token's image, committed at launch
    ///         so the visual identity is permanent and resolvable from
    ///         bytecode alone.
    string public imageURI;

    /// @notice Short human-readable description of the research project
    ///         this token funds. One-time commitment at launch.
    string public description;

    /// @notice Optional project website URL. Empty string if not provided.
    string public website;

    /// @notice Optional Telegram URL. Empty string if not provided.
    string public telegram;

    /// @notice Optional X (Twitter) URL. Empty string if not provided.
    string public xUrl;

    /// @notice Off-chain evidence URI committed at launch (e.g. a PubMed
    ///         DOI, arXiv ID, IPFS preprint hash, RCSB PDB ID, EticaLabs
    ///         run ID, or ORCID attestation). Stored on-chain so the
    ///         token's scientific provenance can be retrieved from
    ///         bytecode alone.
    string public evidenceURI;

    /// @notice Bundle of metadata strings passed at construction time. Kept
    ///         as a struct to keep the constructor under the 16-local
    ///         limit Solidity imposes on stack variables.
    struct Metadata {
        string name;
        string symbol;
        string imageURI;
        string description;
        string website;
        string telegram;
        string xUrl;
        string evidenceURI;
    }

    error NotMarket(address caller, address market);
    error ZeroMarket();
    error ZeroResearcher();

    constructor(Metadata memory m, address market_, address researcher_)
        ERC20(m.name, m.symbol)
        ERC20Permit(m.name)
    {
        if (market_ == address(0)) revert ZeroMarket();
        if (researcher_ == address(0)) revert ZeroResearcher();
        market = market_;
        researcher = researcher_;
        imageURI = m.imageURI;
        description = m.description;
        website = m.website;
        telegram = m.telegram;
        xUrl = m.xUrl;
        evidenceURI = m.evidenceURI;
    }

    /// @notice Mint new tokens to `to`. Only callable by the singleton.
    /// @dev    Called by EticaResearchMarkets.buy(...) to materialize the
    ///         tokens a buyer receives from the bonding curve.
    function mintFromMarket(address to, uint256 amount) external {
        if (msg.sender != market) revert NotMarket(msg.sender, market);
        _mint(to, amount);
    }

    /// @notice Burn `amount` from `from`. Only callable by the singleton.
    /// @dev    Called by EticaResearchMarkets.sell(...) to remove the
    ///         tokens a seller surrenders to the bonding curve. The
    ///         singleton is responsible for verifying the seller has
    ///         actually transferred or approved the tokens.
    function burnFromMarket(address from, uint256 amount) external {
        if (msg.sender != market) revert NotMarket(msg.sender, market);
        _burn(from, amount);
    }
}
