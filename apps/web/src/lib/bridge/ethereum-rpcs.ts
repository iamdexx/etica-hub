/** Keyless Ethereum mainnet endpoints, tried in order (same rotation the keeper and deploy workflow use). */
export const ETHEREUM_PUBLIC_RPCS = [
  'https://gateway.tenderly.co/public/mainnet',
  'https://rpc.mevblocker.io',
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
] as const;

/**
 * Subset safe to call from a browser: MEV Blocker answers CORS preflights
 * with 429 and no `Access-Control-Allow-Origin`, so every wagmi read through
 * it fails before reaching the fallback transport.
 */
export const ETHEREUM_BROWSER_RPCS = ETHEREUM_PUBLIC_RPCS.filter(
  (url) => url !== 'https://rpc.mevblocker.io',
);
