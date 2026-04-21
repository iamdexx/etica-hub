import { fallback, http } from 'viem';
import { createConfig } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';
import { eticaMainnet, eticaLocalFork } from '@etica-hub/shared/chains';

/**
 * Single source of truth for the wallet/RPC config.
 *
 * Two connectors are registered:
 *
 *   1. **`injected`** — the standard in-browser EIP-1193 path. Covers desktop
 *      MetaMask / Rabby / Brave Wallet, and anything opened inside a wallet
 *      app's in-app browser (MetaMask mobile, Trust, etc.).
 *
 *   2. **`walletConnect`** — WalletConnect v2 pairing via Reown's relay. This
 *      is what unblocks mobile browsers that DON'T inject `window.ethereum`
 *      (Brave mobile, Vanadium on GrapheneOS, plain mobile Safari/Chrome).
 *      Those users scan a QR on desktop or tap a "Connect wallet app" link
 *      on mobile to pair with MetaMask / Rainbow / Trust / Coinbase Wallet
 *      / etc. via WalletConnect.
 *
 * The WalletConnect project id is a **public** identifier — it ships in the
 * web bundle and is safe to commit. It only gates relay usage; the relay
 * operator (Reown) rate-limits abuse. It can be overridden at deploy time
 * via `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` for rotation.
 *
 * Mainnet is the only live chain. The local anvil fork is registered so
 * devs can run the UI against a local dev node; it's gated at the UI layer
 * so production builds treat only mainnet as supported.
 */

// Public, non-secret identifier. Overridable via env for rotation.
const DEFAULT_WALLETCONNECT_PROJECT_ID = '62e7452dd44d83bbfe12c92ef0da6bf6';
const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || DEFAULT_WALLETCONNECT_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains: [eticaMainnet, eticaLocalFork],
  connectors: [
    injected({ shimDisconnect: true }),
    walletConnect({
      projectId: WALLETCONNECT_PROJECT_ID,
      showQrModal: true,
      metadata: {
        name: 'EticaHub',
        description: 'Non-custodial trading + liquidity on the Etica network',
        url: 'https://eticahub.com',
        icons: ['https://eticahub.com/favicon.ico'],
      },
    }),
  ],
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
