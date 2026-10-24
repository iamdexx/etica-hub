import type { Metadata } from 'next';
import Link from 'next/link';
import { DEPLOYMENTS, USDC_WARP_ROUTE } from '@etica-hub/shared';

import { PageHero } from '@/components/PageHero';
import { AddNetworkButton } from '@/components/network/AddNetworkButton';
import { AddTokenButton } from '@/components/network/AddTokenButton';
import { absoluteUrl } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Add Etica to your wallet — EticaHub',
  description: 'Etica Mainnet wallet settings, RPCs, token addresses and network setup instructions.',
  alternates: { canonical: absoluteUrl('/network') },
};

const SETTINGS = [
  ['Network name', 'Etica Mainnet'],
  ['Chain ID', '61803 (0xf16b)'],
  ['RPC URL', 'https://eticamainnet.eticaprotocol.org'],
  ['Alternate RPC', 'https://eticamainnet.eticascan.org'],
  ['Currency symbol', 'EGAZ'],
  ['Native currency decimals', '18'],
  ['Block explorer', 'https://eticahub.com/explorer'],
] as const;

const TOKENS = [
  { symbol: 'ETX', address: DEPLOYMENTS[61803].etx, decimals: 18, image: '/logos/etx.png' },
  { symbol: 'stETX', address: DEPLOYMENTS[61803].stakedETX, decimals: 18, image: '/logos/stetx.png' },
  { symbol: 'USDC.e', address: USDC_WARP_ROUTE.syntheticToken, decimals: 6, image: '/logos/usdc.png' },
] as const;

export default function NetworkPage() {
  return (
    <div className="space-y-8">
      <PageHero
        tone="sky"
        size="md"
        eyebrow="Wallet setup"
        title="Connect to Etica Mainnet."
        description="Add the network, check the chain ID, then import the tokens you use. Adding a network or watching a token does not spend funds."
      />
      <section className="surface space-y-5 p-5 md:p-6" aria-labelledby="network-settings">
        <h2 id="network-settings" className="text-xl font-semibold">Network settings</h2>
        <AddNetworkButton />
        <dl className="divide-y divide-white/10 text-sm">
          {SETTINGS.map(([label, value]) => (
            <div key={label} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr]">
              <dt className="text-white/60">{label}</dt>
              <dd className="min-w-0 break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-white/65">EGAZ pays transaction fees. Native EGAZ has no token contract to import. Never enter your seed phrase or private key into this site.</p>
      </section>
      <section className="grid gap-4 md:grid-cols-2" aria-label="Wallet instructions">
        <article className="surface space-y-3 p-5">
          <h2 className="text-lg font-semibold">MetaMask</h2>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-white/75">
            <li>Use the add-network button above, then review the network details in your wallet.</li>
            <li>If it does not open your wallet, open MetaMask&apos;s network selector and choose to add a custom network manually.</li>
            <li>Enter the settings above, save, and switch to Etica Mainnet.</li>
          </ol>
          <p className="text-sm text-white/65">On mobile, open EticaHub inside MetaMask&apos;s browser. A custom network is not an endorsement or a Popular Networks listing.</p>
        </article>
        <article className="surface space-y-3 p-5">
          <h2 className="text-lg font-semibold">Rabby</h2>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-white/75">
            <li>Open Rabby&apos;s settings and choose Custom Network.</li>
            <li>Add the RPC URL above; verify chain ID 61803 and EGAZ before saving.</li>
            <li>Connect to EticaHub and select Etica for the connection.</li>
          </ol>
          <p className="text-sm text-white/65">Custom-network support does not imply native Rabby indexing, portfolio valuation or transaction simulation for Etica.</p>
        </article>
        <article className="surface space-y-3 p-5">
          <h2 className="text-lg font-semibold">Coinbase Wallet, Rainbow and other wallets</h2>
          <p className="text-sm text-white/75">If your wallet version provides a custom EVM network option, use the exact settings above. If it does not support chain 61803, use a wallet with custom-network support instead. Do not send Etica assets using an Ethereum or Base network entry.</p>
        </article>
        <article className="surface space-y-3 p-5">
          <h2 className="text-lg font-semibold">WalletConnect / Reown</h2>
          <p className="text-sm text-white/75">WalletConnect is a connection method, not a bridge or network listing. The connected wallet must support Etica (CAIP-2 identifier <code>eip155:61803</code>). A successful connection alone does not confirm support for signing Etica transactions.</p>
        </article>
      </section>
      <section className="surface space-y-5 p-5 md:p-6" aria-labelledby="network-tokens">
        <h2 id="network-tokens" className="text-xl font-semibold">Import tokens on Etica</h2>
        <div className="space-y-4">
          {TOKENS.map((token) => (
            <div key={token.symbol} className="space-y-2">
              <p className="text-sm">{token.symbol} · {token.decimals} decimals</p>
              <p className="break-all font-mono text-xs text-white/65">{token.address}</p>
              <AddTokenButton token={token.symbol} />
            </div>
          ))}
        </div>
        <p className="text-sm text-white/65">Public token list: <a className="underline" href="/tokenlist.json">https://eticahub.com/tokenlist.json</a>. Wallets may not display imported logos or prices. USDC.e is bridged USDC on Etica, not native Circle-issued USDC.</p>
        <Link className="btn-ghost inline-flex px-4 py-2" href="/tutorials">Bridge and swap tutorials</Link>
      </section>
    </div>
  );
}
