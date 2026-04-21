'use client';

import { useEffect, useState } from 'react';
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { eticaMainnet, eticaLocalFork } from '@etica-hub/shared/chains';
import { shortAddress } from '@/lib/utils';

const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * Returns true on mobile browsers that do NOT inject an `ethereum` provider
 * (Brave mobile, Vanadium on GrapheneOS, mobile Safari/Chrome without an
 * extension). On those browsers the `injected` connector has nothing to
 * connect to, so the plain Connect Wallet button appears to do nothing when
 * tapped. We detect this case post-mount and show a deep-link button that
 * opens the current page inside MetaMask's in-app browser instead.
 */
function useIsMobileWithoutInjected(): boolean {
  const [state, setState] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ua = navigator.userAgent || '';
    const isMobile = /Android|iPhone|iPad|iPod|Mobile|GrapheneOS|Vanadium/i.test(ua);
    const hasInjected =
      typeof (window as Window & { ethereum?: unknown }).ethereum !== 'undefined';
    setState(isMobile && !hasInjected);
  }, []);
  return state;
}

/**
 * Builds a `metamask.app.link` universal link that opens the current URL
 * inside the MetaMask app's in-app browser. This works from any mobile
 * browser (Brave, Vanadium, Safari, Chrome) as long as the MetaMask app is
 * installed — iOS / Android handle the universal-link redirect themselves.
 * Format is MetaMask's documented deep-link spec: `dapp/<host><path>`.
 */
function buildMetaMaskDeepLink(): string {
  if (typeof window === 'undefined') return 'https://metamask.app.link/';
  const { host, pathname, search } = window.location;
  return `https://metamask.app.link/dapp/${host}${pathname}${search}`;
}

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const showDeepLink = useIsMobileWithoutInjected();

  if (!isConnected) {
    const injected = connectors.find((c) => c.id === 'injected') ?? connectors[0];
    // Mobile-without-extension users see a dedicated "Open in MetaMask" button,
    // which is the only one that actually reaches a wallet in Brave mobile /
    // Vanadium / GrapheneOS. We hide the regular Connect button for them to
    // avoid the "nothing happens" UX — tapping it would just do nothing.
    if (showDeepLink) {
      return (
        <a
          href={buildMetaMaskDeepLink()}
          className="rounded-full bg-brand-accent px-4 py-1.5 text-sm font-medium text-brand-ink hover:opacity-90"
        >
          Open in MetaMask
        </a>
      );
    }
    return (
      <button
        onClick={() => injected && connect({ connector: injected })}
        disabled={isPending}
        className="rounded-full bg-brand-accent px-4 py-1.5 text-sm font-medium text-brand-ink hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? 'Connecting…' : 'Connect Wallet'}
      </button>
    );
  }

  const onSupportedChain =
    chainId === eticaMainnet.id || (IS_DEV && chainId === eticaLocalFork.id);
  const switchTarget = IS_DEV ? eticaLocalFork : eticaMainnet;

  return (
    <div className="flex items-center gap-2">
      {!onSupportedChain && (
        <button
          onClick={() => switchChain({ chainId: switchTarget.id })}
          disabled={isSwitching}
          className="rounded-full border border-yellow-500/40 bg-yellow-500/10 px-3 py-1.5 text-xs font-medium text-yellow-300 hover:bg-yellow-500/20 disabled:opacity-50"
        >
          {isSwitching ? 'Switching…' : `Switch to ${switchTarget.name}`}
        </button>
      )}
      <button
        onClick={() => disconnect()}
        className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm font-mono hover:bg-white/10"
        title={address}
      >
        {shortAddress(address ?? '')}
      </button>
    </div>
  );
}
