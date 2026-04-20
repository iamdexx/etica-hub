/**
 * Minimal ABI for the Etica core contract (EticaRelease.sol on mainnet at
 * 0x34c61EA91bAcdA647269d4e310A86b875c09946f, same address for ETI token).
 *
 * Only the surface EticaHub's Research module reads from / listens to:
 *   - proposalsCounter / proposalsbyIndex / proposals / propsdatas
 *   - diseasesCounter / diseases / diseasesbyIds
 *   - NewProposal / NewDisease / NewReveal events
 *
 * Full upstream source: https://github.com/etica/etica
 */
export const eticaCoreAbi = [
  // ------- proposals -------
  {
    type: 'function',
    name: 'proposalsCounter',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'proposalsbyIndex',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'proposals',
    stateMutability: 'view',
    inputs: [{ name: 'proposedReleaseHash', type: 'bytes32' }],
    outputs: [
      { name: 'id', type: 'uint256' },
      { name: 'proposed_release_hash', type: 'bytes32' },
      { name: 'disease_id', type: 'bytes32' },
      { name: 'period_id', type: 'uint256' },
      { name: 'chunk_id', type: 'uint256' },
      { name: 'proposer', type: 'address' },
      { name: 'title', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'freefield', type: 'string' },
      { name: 'raw_release_hash', type: 'string' },
    ],
  },
  {
    type: 'function',
    name: 'propsdatas',
    stateMutability: 'view',
    inputs: [{ name: 'proposedReleaseHash', type: 'bytes32' }],
    outputs: [
      { name: 'starttime', type: 'uint256' },
      { name: 'endtime', type: 'uint256' },
      { name: 'finalized_time', type: 'uint256' },
      { name: 'status', type: 'uint8' },
      { name: 'prestatus', type: 'uint8' },
      { name: 'istie', type: 'bool' },
      { name: 'nbvoters', type: 'uint256' },
      { name: 'slashingratio', type: 'uint256' },
      { name: 'forvotes', type: 'uint256' },
      { name: 'againstvotes', type: 'uint256' },
      { name: 'lastcuration_weight', type: 'uint256' },
      { name: 'lasteditor_weight', type: 'uint256' },
      { name: 'approvalthreshold', type: 'uint256' },
    ],
  },

  // ------- diseases -------
  {
    type: 'function',
    name: 'diseasesCounter',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'diseases',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [
      { name: 'disease_hash', type: 'bytes32' },
      { name: 'name', type: 'string' },
    ],
  },
  {
    type: 'function',
    name: 'diseasesbyIds',
    stateMutability: 'view',
    inputs: [{ name: 'diseaseHash', type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },

  // ------- events -------
  {
    type: 'event',
    name: 'NewProposal',
    inputs: [
      { indexed: false, name: 'proposed_release_hash', type: 'bytes32' },
      { indexed: true, name: '_proposer', type: 'address' },
      { indexed: true, name: 'diseasehash', type: 'bytes32' },
      { indexed: true, name: 'chunkid', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'NewDisease',
    inputs: [
      { indexed: true, name: 'diseaseindex', type: 'uint256' },
      { indexed: false, name: 'title', type: 'string' },
    ],
  },
  {
    type: 'event',
    name: 'NewReveal',
    inputs: [
      { indexed: true, name: '_voter', type: 'address' },
      { indexed: true, name: '_proposal', type: 'bytes32' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
] as const;

/** Proposal lifecycle status, as emitted by {@link eticaCoreAbi} `propsdatas.status`. */
export enum ProposalStatus {
  Rejected = 0,
  Accepted = 1,
  Pending = 2,
  Singlevoter = 3,
}

export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  [ProposalStatus.Rejected]: 'Rejected',
  [ProposalStatus.Accepted]: 'Accepted',
  [ProposalStatus.Pending]: 'Pending',
  [ProposalStatus.Singlevoter]: 'Single voter',
};
