export const researchSubscriptionAbi = [
  {
    type: 'function',
    name: 'eti',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'treasury',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'pricePerMonth',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'expiresAt',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isActive',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'subscribe',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'months_', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Subscribed',
    inputs: [
      { indexed: true, name: 'subscriber', type: 'address' },
      { indexed: false, name: 'months_', type: 'uint256' },
      { indexed: false, name: 'paid', type: 'uint256' },
      { indexed: false, name: 'newExpiry', type: 'uint256' },
    ],
  },
] as const;
