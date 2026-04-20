export * from './chains';
export * from './addresses';
export * as abis from './abis/index';

// Re-export a couple of core enums/labels directly so consumers can use
// `PROPOSAL_STATUS_LABEL` without reaching through the `abis` namespace.
export { ProposalStatus, PROPOSAL_STATUS_LABEL } from './abis/eticaCore';
