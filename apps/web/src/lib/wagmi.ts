import { fallback, http } from 'viem';
import { createConfig } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { eticaMainnet, eticaLocalFork } from '@etica-hub/shared/chains';

/**
 * Single source of truth for the wallet/RPC config.
 *
 * Only injected (MetaMask-style) connectors are enabled until we have a
 * WalletConnect project id — add WC later in a follow-up.
 *
 * Mainnet is the only live chain. The local anvil fork is registered so
 * devs can run the UI against a local dev node; it's gated at the UI layer
 * so production builds treat only mainnet as supported.
 */
export const wagmiConfig = createConfig({
  chains: [eticaMainnet, eticaLocalFork],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [eticaMainnet.id]: fallback(
      eticaMainnet.rpcUrls.default.http.map((url) =>
        http(url, { timeout: 10_000, retryCount: 2 }),
      ),
      { rank: false },
    ),
    [eticaLocalFork.id]: http(),
  },
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
