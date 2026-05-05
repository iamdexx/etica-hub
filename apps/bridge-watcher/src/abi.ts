/**
 * Minimal ABIs for the bridge-watcher.
 *
 * Only the surface the watcher actually touches is included. The full
 * contract ABIs live in `packages/contracts/out` and are inlined into the
 * frontend via `packages/shared/src/abis` when needed.
 *
 * Source-of-truth contracts:
 *   - `packages/contracts/src/bridge/BridgeMinter.sol` (remote chains)
 *   - `packages/contracts/src/bridge/BridgeVault.sol`  (Etica)
 */

export const bridgeMinterAbi = [
  // ─── Heartbeat ──────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'heartbeat',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'checkHeartbeat',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool', name: 'isHealthy' }],
  },
  {
    type: 'function',
    name: 'lastHeartbeatAt',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'heartbeatSigner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'heartbeatTimeout',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint64' }],
  },
  // ─── Claim lifecycle ────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'executeClaim',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'bytes32', name: 'nonce' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  // The `claims` mapping getter returns a packed tuple. Solidity emits
  // each storage variable in declaration order; trailing dynamic fields
  // (none here) would be omitted.
  {
    type: 'function',
    name: 'claims',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32', name: 'nonce' }],
    outputs: [
      { type: 'address', name: 'recipient' },
      { type: 'uint128', name: 'amount' },
      { type: 'address', name: 'submitter' },
      { type: 'uint128', name: 'bondWei' },
      { type: 'uint64', name: 'expiresAt' },
      { type: 'uint8', name: 'state' }, // ClaimState enum: 0 NONE | 1 RECORDED | 2 PENDING | 3 EXECUTED | 4 VETOED
      { type: 'uint32', name: 'origin' },
    ],
  },
  // ─── Events ─────────────────────────────────────────────────────────────
  {
    type: 'event',
    name: 'ClaimSubmitted',
    anonymous: false,
    inputs: [
      { type: 'bytes32', name: 'nonce', indexed: true },
      { type: 'address', name: 'submitter', indexed: true },
      { type: 'address', name: 'recipient', indexed: true },
      { type: 'uint128', name: 'amount', indexed: false },
      { type: 'uint128', name: 'bondWei', indexed: false },
      { type: 'uint64', name: 'expiresAt', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ClaimExecuted',
    anonymous: false,
    inputs: [
      { type: 'bytes32', name: 'nonce', indexed: true },
      { type: 'address', name: 'recipient', indexed: true },
      { type: 'uint128', name: 'amount', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ClaimVetoed',
    anonymous: false,
    inputs: [
      { type: 'bytes32', name: 'nonce', indexed: true },
      { type: 'address', name: 'vetoer', indexed: true },
      { type: 'uint8', name: 'reason', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Heartbeat',
    anonymous: false,
    inputs: [
      { type: 'address', name: 'signer', indexed: true },
      { type: 'uint64', name: 'timestamp', indexed: false },
    ],
  },
] as const;

export const bridgeVaultAbi = [
  {
    type: 'event',
    name: 'Deposit',
    anonymous: false,
    inputs: [
      { type: 'bytes32', name: 'nonce', indexed: true },
      { type: 'address', name: 'sender', indexed: true },
      { type: 'address', name: 'recipient', indexed: true },
      { type: 'uint32', name: 'destDomain', indexed: false },
      { type: 'uint128', name: 'amountNet', indexed: false },
      { type: 'uint128', name: 'fee', indexed: false },
    ],
  },
] as const;
