import { http } from 'viem';
import { createConfig } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { eticaMainnet, eticaCrucible } from '@etica-hub/shared/chains';

/**
 * Single source of truth for the wallet/RPC config.
 *
 * Only injected (MetaMask-style) connectors are enabled until we have a
 * WalletConnect project id — add WC later in a follow-up.
 */
export const wagmiConfig = createConfig({
  chains: [eticaMainnet, eticaCrucible],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [eticaMainnet.id]: http(),
    [eticaCrucible.id]: http(),
  },
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
