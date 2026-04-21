'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import type { Connector } from 'wagmi';
import { eticaMainnet, eticaLocalFork } from '@etica-hub/shared/chains';
import { shortAddress } from '@/lib/utils';

const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * Returns true on mobile browsers that do NOT inject an `ethereum` provider
 * (Brave mobile, Vanadium on GrapheneOS, mobile Safari/Chrome without an
 * extension). We surface a MetaMask deep-link button for those users — the
 * injected connector can't reach anything on their browser, but iOS/Android
 * universal-link the `metamask.app.link/dapp/...` URL to MetaMask's in-app
 * browser which loads the page with `window.ethereum` injected.
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
 * inside the MetaMask app's in-app browser. Format is MetaMask's documented
 * deep-link spec: `dapp/<host><path>`.
 */
function buildMetaMaskDeepLink(): string {
  if (typeof window === 'undefined') return 'https://metamask.app.link/';
  const { host, pathname, search } = window.location;
  return `https://metamask.app.link/dapp/${host}${pathname}${search}`;
}

function labelFor(connector: Connector): string {
  if (connector.id === 'injected') return 'Browser extension (MetaMask, Rabby, Brave)';
  if (connector.id === 'walletConnect') return 'WalletConnect (scan QR or mobile wallet)';
  return connector.name;
}

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const showDeepLink = useIsMobileWithoutInjected();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the menu when the user clicks outside of it.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  // Collapse the menu once a connection succeeds (wagmi flips isConnected).
  useEffect(() => {
    if (isConnected) setMenuOpen(false);
  }, [isConnected]);

  if (!isConnected) {
    return (
      <div ref={menuRef} className="relative">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          disabled={isPending}
          className="rounded-full bg-brand-accent px-4 py-1.5 text-sm font-medium text-brand-ink hover:opacity-90 disabled:opacity-50"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          {isPending ? 'Connecting…' : 'Connect Wallet'}
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 mt-2 w-72 rounded-xl border border-white/10 bg-brand-ink/95 p-2 shadow-lg backdrop-blur"
          >
            {connectors.map((connector) => (
              <button
                key={connector.uid}
                onClick={() => {
                  connect({ connector });
                  setMenuOpen(false);
                }}
                className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/90 hover:bg-white/5"
                role="menuitem"
              >
                {labelFor(connector)}
              </button>
            ))}
            {showDeepLink && (
              <a
                href={buildMetaMaskDeepLink()}
                className="block w-full rounded-lg px-3 py-2 text-left text-sm text-white/90 hover:bg-white/5"
                role="menuitem"
              >
                Open in MetaMask app
              </a>
            )}
            <p className="mt-1 px-3 pb-1 pt-2 text-[11px] leading-snug text-white/40">
              On Brave mobile, Vanadium, or any browser without a wallet
              extension, use WalletConnect or &ldquo;Open in MetaMask&rdquo;.
            </p>
          </div>
        )}
      </div>
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
