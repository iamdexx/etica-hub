/** Keyless Ethereum mainnet endpoints, tried in order (same rotation the keeper and deploy workflow use). */
export const ETHEREUM_PUBLIC_RPCS = [
  'https://gateway.tenderly.co/public/mainnet',
  'https://rpc.mevblocker.io',
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
] as const;
