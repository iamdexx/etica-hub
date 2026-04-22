/**
 * ABI for the ETXFarms LP staking contract.
 *
 * Source: packages/contracts/src/etx/ETXFarms.sol. Only the functions and
 * events the frontend actually reads/writes are included; full compiler
 * output lives in apps/web/src/lib/etx-farms-artifact.json.
 */
export const etxFarmsAbi = [
  // ─── Views ─────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'rewardToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'fallbackRecipient',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'totalAllocPoint',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'poolLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'poolInfo',
    stateMutability: 'view',
    inputs: [{ name: 'pid', type: 'uint256' }],
    outputs: [
      { name: 'lpToken', type: 'address' },
      { name: 'allocPoint', type: 'uint256' },
      { name: 'totalStaked', type: 'uint256' },
      { name: 'accRewardPerShare', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'userInfo',
    stateMutability: 'view',
    inputs: [
      { name: 'pid', type: 'uint256' },
      { name: 'user', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'rewardDebt', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'pendingReward',
    stateMutability: 'view',
    inputs: [
      { name: 'pid', type: 'uint256' },
      { name: 'user', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  // ─── Writes ────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'pid', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'pid', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'harvest',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'pid', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'emergencyWithdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'pid', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'distributeRewards',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  // ─── Owner writes ──────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'addPool',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'lpToken', type: 'address' },
      { name: 'allocPoint', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setAllocPoint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'pid', type: 'uint256' },
      { name: 'newAllocPoint', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setFallbackRecipient',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newRecipient', type: 'address' }],
    outputs: [],
  },
  // ─── Events ────────────────────────────────────────────────────────────
  {
    type: 'event',
    name: 'PoolAdded',
    inputs: [
      { indexed: true, name: 'pid', type: 'uint256' },
      { indexed: true, name: 'lpToken', type: 'address' },
      { indexed: false, name: 'allocPoint', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'RewardsDistributed',
    inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'Deposit',
    inputs: [
      { indexed: true, name: 'user', type: 'address' },
      { indexed: true, name: 'pid', type: 'uint256' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'Withdraw',
    inputs: [
      { indexed: true, name: 'user', type: 'address' },
      { indexed: true, name: 'pid', type: 'uint256' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'Harvest',
    inputs: [
      { indexed: true, name: 'user', type: 'address' },
      { indexed: true, name: 'pid', type: 'uint256' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
] as const;
