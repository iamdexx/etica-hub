/**
 * Minimal Phase 3 bridge ABIs for the EticaHub website.
 *
 * Scoped to the surface the public UI actually reads:
 *   - {@link bridgeVaultAbi}: Etica-side TVL + per-claim params + recent
 *     {@link Deposit} events.
 *   - {@link bridgeMinterAbi}: remote-chain pending claims + claim params +
 *     {@link ClaimSubmitted} / {@link ClaimExecuted} / {@link ClaimVetoed}
 *     events.
 *   - {@link bridgeInsuranceFundAbi}: backstop coverage.
 *
 * Write functions (deposit, submitClaim, executeClaim, burnAndUnlock,
 * vetoClaim) are intentionally not exported from the website bundle — those
 * land in a follow-up PR alongside multi-chain wagmi config.
 */
export const bridgeVaultAbi = [
  { type: 'function', name: 'locked', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'tvlCap', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'bridgeFeeBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'dailyMintCapBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'perClaimCapBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  {
    type: 'event',
    name: 'Deposit',
    inputs: [
      { name: 'nonce', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'destDomain', type: 'uint32', indexed: false },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'amountNet', type: 'uint256', indexed: false },
      { name: 'feeBps', type: 'uint16', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'WithdrawExecuted',
    inputs: [
      { name: 'nonce', type: 'bytes32', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const bridgeMinterAbi = [
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'tvlCap', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'minted', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'bondBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'challengeWindowSeconds', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint32' }] },
  { type: 'function', name: 'lastHeartbeatAt', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  { type: 'function', name: 'heartbeatTimeout', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint32' }] },
  {
    type: 'function',
    name: 'claims',
    stateMutability: 'view',
    inputs: [{ name: 'nonce', type: 'bytes32' }],
    outputs: [
      { name: 'submitter', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint128' },
      { name: 'bond', type: 'uint128' },
      { name: 'expiresAt', type: 'uint64' },
      { name: 'state', type: 'uint8' },
    ],
  },
  {
    type: 'event',
    name: 'ClaimSubmitted',
    inputs: [
      { name: 'nonce', type: 'bytes32', indexed: true },
      { name: 'submitter', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint128', indexed: false },
      { name: 'bond', type: 'uint128', indexed: false },
      { name: 'expiresAt', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ClaimExecuted',
    inputs: [
      { name: 'nonce', type: 'bytes32', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint128', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ClaimVetoed',
    inputs: [
      { name: 'nonce', type: 'bytes32', indexed: true },
      { name: 'reason', type: 'bytes32', indexed: false },
    ],
  },
] as const;

export const bridgeInsuranceFundAbi = [
  { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
] as const;

/**
 * Bridge claim states, mirrored from the on-chain `ClaimState` enum on
 * `BridgeMinter`. Order matters — values are compared numerically.
 */
export const BRIDGE_CLAIM_STATE = {
  NONE: 0,
  RECORDED: 1,
  PENDING: 2,
  EXECUTED: 3,
  VETOED: 4,
} as const;

export type BridgeClaimState = (typeof BRIDGE_CLAIM_STATE)[keyof typeof BRIDGE_CLAIM_STATE];
