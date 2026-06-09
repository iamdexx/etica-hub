export const eticaResearchMarketplaceAbi = [
  {
    type: 'constructor',
    inputs: [{ name: 'nft_', type: 'address' }],
    stateMutability: 'nonpayable',
  },
  // ─── Events ───────────────────────────────────────────────────
  {
    type: 'event',
    name: 'Listed',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'seller', type: 'address', indexed: true },
      { name: 'price', type: 'uint128', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Unlisted',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'seller', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Sold',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'seller', type: 'address', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'price', type: 'uint128', indexed: false },
      { name: 'royaltyPaid', type: 'uint256', indexed: false },
    ],
  },
  // ─── Errors ───────────────────────────────────────────────────
  { type: 'error', name: 'NotOwner', inputs: [] },
  { type: 'error', name: 'NotApproved', inputs: [] },
  { type: 'error', name: 'PriceZero', inputs: [] },
  { type: 'error', name: 'NotListed', inputs: [] },
  { type: 'error', name: 'CannotBuyOwn', inputs: [] },
  { type: 'error', name: 'InsufficientPayment', inputs: [] },
  { type: 'error', name: 'TransferFailed', inputs: [] },
  // ─── Read ─────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'nft',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'listings',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'seller', type: 'address' },
      { name: 'price', type: 'uint128' },
      { name: 'listedAt', type: 'uint64' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'totalListings',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getListings',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [
      { name: 'tokenIds', type: 'uint256[]' },
      {
        name: 'items',
        type: 'tuple[]',
        components: [
          { name: 'seller', type: 'address' },
          { name: 'price', type: 'uint128' },
          { name: 'listedAt', type: 'uint64' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isListed',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'listedTokenIds',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  // ─── Write ────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'list',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'price', type: 'uint128' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'cancel',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'buy',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'payable',
  },
] as const;
