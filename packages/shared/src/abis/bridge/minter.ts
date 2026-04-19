/**
 * Minimal ABI for {@link EthereumBridgeMinter} — only the surface the relayer,
 * indexer, and UI need.
 */
export const ethereumBridgeMinterAbi = [
  {
    type: 'event',
    name: 'Minted',
    inputs: [
      { name: 'nonce', type: 'bytes32', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'netAmount', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'srcTxHash', type: 'bytes32', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Burned',
    inputs: [
      { name: 'nonce', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'recipient', type: 'address', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'srcChainId', type: 'uint256' },
      { name: 'srcTxHash', type: 'bytes32' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      { name: 'recipient', type: 'address' },
      { name: 'signatures', type: 'bytes[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'burn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'nonce', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'processed',
    stateMutability: 'view',
    inputs: [{ name: 'nonce', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'weti',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'remoteChainId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'feeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'buildDigest',
    stateMutability: 'pure',
    inputs: [
      { name: 'srcChainId', type: 'uint256' },
      { name: 'dstChainId', type: 'uint256' },
      { name: 'srcTxHash', type: 'bytes32' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'tokenAddr', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const;
