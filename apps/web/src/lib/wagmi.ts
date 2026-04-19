import { http } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { createConfig } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { eticaMainnet, eticaCrucible, eticaLocalFork } from '@etica-hub/shared/chains';

/**
 * Single source of truth for the wallet/RPC config.
 *
 * Only injected (MetaMask-style) connectors are enabled until we have a
 * WalletConnect project id — add WC later in a follow-up.
 *
 * The local anvil fork is always included so devs/testers can point at it
 * without touching code. It's gated at the UI layer for non-dev builds.
 */
export const wagmiConfig = createConfig({
  // Ethereum mainnet + Sepolia are registered so wagmi can prompt a chain
  // switch to the destination side of the bridge; the app itself still
  // gates bridge actions on `BRIDGE_ETHEREUM_DEPLOYMENTS`.
  chains: [eticaMainnet, eticaCrucible, eticaLocalFork, mainnet, sepolia],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [eticaMainnet.id]: http(),
    [eticaCrucible.id]: http(),
    [eticaLocalFork.id]: http(),
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
