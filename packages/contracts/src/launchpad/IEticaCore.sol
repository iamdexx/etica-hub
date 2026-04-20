// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal interface for the Etica core contract used by the
///         proposal-token launchpad to verify that the caller is the
///         original author of a given proposal.
///
///         Mainnet address: 0x34c61EA91bAcdA647269d4e310A86b875c09946f
interface IEticaCore {
    /// @notice Look up a proposal by its `proposed_release_hash`.
    /// @return id                    Numeric index of the proposal.
    /// @return proposed_release_hash Proposal hash.
    /// @return disease_id            Disease group this proposal belongs to.
    /// @return period_id             Voting period.
    /// @return chunk_id              Data chunk the proposal targets.
    /// @return proposer              Wallet that submitted the proposal.
    /// @return title                 Proposal title.
    /// @return description           Proposal description.
    /// @return freefield             Author-supplied extra field.
    /// @return raw_release_hash      Raw hash string.
    function proposals(bytes32 proposedReleaseHash)
        external
        view
        returns (
            uint256 id,
            bytes32 proposed_release_hash,
            bytes32 disease_id,
            uint256 period_id,
            uint256 chunk_id,
            address proposer,
            string memory title,
            string memory description,
            string memory freefield,
            string memory raw_release_hash
        );
}
