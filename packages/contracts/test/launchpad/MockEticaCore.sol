// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IEticaCore} from "../../src/launchpad/IEticaCore.sol";

/// @notice Test-only stand-in for the Etica core contract. Only exposes the
///         `proposals()` getter used by {ProposalTokenFactory}; the
///         parent test registers proposal hash → proposer mappings.
contract MockEticaCore is IEticaCore {
    mapping(bytes32 => address) public proposer;

    function register(bytes32 proposalHash, address author) external {
        proposer[proposalHash] = author;
    }

    function proposals(bytes32 proposedReleaseHash)
        external
        view
        returns (
            uint256 id,
            bytes32 proposed_release_hash,
            bytes32 disease_id,
            uint256 period_id,
            uint256 chunk_id,
            address proposer_,
            string memory title,
            string memory description,
            string memory freefield,
            string memory raw_release_hash
        )
    {
        proposer_ = proposer[proposedReleaseHash];
        proposed_release_hash = proposedReleaseHash;
        // other fields deliberately zeroed; factory only reads `proposer`.
        id;
        disease_id;
        period_id;
        chunk_id;
        title;
        description;
        freefield;
        raw_release_hash;
    }
}
