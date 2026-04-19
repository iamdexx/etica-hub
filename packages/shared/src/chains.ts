import { defineChain } from 'viem';

/**
 * Etica Mainnet (chain ID 61803).
 *
 * Native gas token is EGAZ. ETI is the protocol's research token and lives
 * at {@link ETI_ADDRESS_MAINNET}. See https://www.eticaprotocol.org/.
 */
export const eticaMainnet = defineChain({
  id: 61803,
  name: 'Etica Mainnet',
  nativeCurrency: { name: 'EGAZ', symbol: 'EGAZ', decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        'https://eticamainnet.eticascan.org',
        'https://eticamainnet.eticaprotocol.org',
        'https://61803.rpc.thirdweb.com',
      ],
    },
  },
  blockExplorers: {
    default: { name: 'Eticascan', url: 'https://eticascan.org' },
    eticaStats: { name: 'Etica Stats', url: 'http://explorer.etica-stats.org' },
  },
  testnet: false,
});

/**
 * Etica Crucible Testnet (chain ID 61888).
 *
 * See https://www.eticaprotocol.org/crucibletestnet.
 */
export const eticaCrucible = defineChain({
  id: 61888,
  name: 'Etica Crucible Testnet',
  nativeCurrency: { name: 'EGAZ', symbol: 'EGAZ', decimals: 18 },
  rpcUrls: {
    default: { http: ['http://173.212.202.226:8545'] },
  },
  blockExplorers: {
    default: { name: 'Crucible Explorer', url: 'http://173.212.202.226:8545' },
  },
  testnet: true,
});

export const supportedChains = [eticaMainnet, eticaCrucible] as const;

export type SupportedChainId = (typeof supportedChains)[number]['id'];

export function isSupportedChainId(id: number): id is SupportedChainId {
  return supportedChains.some((c) => c.id === id);
}
