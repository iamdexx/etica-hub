/**
 * Contract ABIs the keeper talks to.
 *
 * Etica-side ABIs are `as const` so viem infers fully-typed reads/writes.
 * TRON-side ABIs are plain JSON arrays (standard Ethereum ABI shape) consumed
 * by tronweb's `tronWeb.contract(abi, address)`.
 *
 * Only the fragments the keeper actually uses are included — kept minimal on
 * purpose so a contract change that doesn't touch these stays compatible.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Etica — ETRX (packages/contracts/src/wres/ETRX.sol)
// ─────────────────────────────────────────────────────────────────────────────
export const ETRX_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'burn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// TRON — WrappedRESMiner (UEM/contracts/src/WrappedRESMiner.sol)
// Plain JSON ABI for tronweb. SUN-denominated amounts.
// ─────────────────────────────────────────────────────────────────────────────
export const WRAPPED_RES_MINER_TRON_ABI = [
  {
    type: 'function',
    name: 'mintTwin',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'payoutWallet', type: 'address' },
      { name: 'resTokenId', type: 'uint256' },
    ],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'claimForPayout',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'receiveRevenue',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'pendingReward',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'miners',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [
      { name: 'resTokenId', type: 'uint256' },
      { name: 'payoutWallet', type: 'address' },
      { name: 'frozenTrx', type: 'uint256' },
      { name: 'rewardDebt', type: 'uint256' },
      { name: 'claimable', type: 'uint256' },
      { name: 'totalEarned', type: 'uint256' },
      { name: 'upgradeCount', type: 'uint256' },
      { name: 'createdAt', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'TwinMinted',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'payoutWallet', type: 'address', indexed: true },
      { name: 'resTokenId', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// TRON — TrxReserve (UEM/contracts/src/TrxReserve.sol)
// ─────────────────────────────────────────────────────────────────────────────
export const TRX_RESERVE_TRON_ABI = [
  {
    type: 'function',
    name: 'frontUpgrade',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'topUp',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'frontableNow',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Fronted',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'remainingThisEpoch', type: 'uint256', indexed: false },
    ],
  },
] as const;
