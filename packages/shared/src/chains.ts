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
        'https://eticamainnet.eticaprotocol.org',
        'https://61803.rpc.thirdweb.com',
        'https://eticamainnet.eticascan.org',
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

/**
 * Local anvil fork of Etica Mainnet used for development and end-to-end
 * testing. Chain ID is deliberately set to anvil's default (31337) so MetaMask
 * and other wallets treat it as a separate network from mainnet.
 *
 * Start it with:
 *   anvil --fork-url https://eticamainnet.eticascan.org \
 *         --chain-id 31337 --host 0.0.0.0 --port 8545
 */
export const eticaLocalFork = defineChain({
  id: 31337,
  name: 'EticaHub Dev (forked mainnet)',
  nativeCurrency: { name: 'EGAZ', symbol: 'EGAZ', decimals: 18 },
  rpcUrls: {
    default: { http: ['http://127.0.0.1:8545'] },
  },
  testnet: true,
});

export const supportedChains = [eticaMainnet, eticaCrucible, eticaLocalFork] as const;

export type SupportedChainId = (typeof supportedChains)[number]['id'];

export function isSupportedChainId(id: number): id is SupportedChainId {
  return supportedChains.some((c) => c.id === id);
}
