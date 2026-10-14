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
    const hasInjected = typeof (window as Window & { ethereum?: unknown }).ethereum !== 'undefined';
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
          className="btn-primary h-9 px-4 py-0 text-[13px]"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          {isPending ? 'Connecting…' : 'Connect Wallet'}
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="surface animate-menu-in absolute right-0 z-50 mt-2 w-72 p-1.5"
          >
            {connectors.map((connector) => (
              <button
                key={connector.uid}
                onClick={() => {
                  connect({ connector });
                  setMenuOpen(false);
                }}
                className="block w-full rounded-xl px-3 py-2.5 text-left text-sm text-white/90 transition-colors hover:bg-white/[0.06]"
                role="menuitem"
              >
                {labelFor(connector)}
              </button>
            ))}
            {showDeepLink && (
              <a
                href={buildMetaMaskDeepLink()}
                className="block w-full rounded-xl px-3 py-2.5 text-left text-sm text-white/90 transition-colors hover:bg-white/[0.06]"
                role="menuitem"
              >
                Open in MetaMask app
              </a>
            )}
            <p className="mt-1 px-3 pb-1 pt-2 text-[11px] leading-snug text-white/40">
              On Brave mobile, Vanadium, or any browser without a wallet extension, use
              WalletConnect or &ldquo;Open in MetaMask&rdquo;.
            </p>
          </div>
        )}
      </div>
    );
  }

  const onSupportedChain = chainId === eticaMainnet.id || (IS_DEV && chainId === eticaLocalFork.id);
  const switchTarget = IS_DEV ? eticaLocalFork : eticaMainnet;

  return (
    <div className="flex items-center gap-2">
      {!onSupportedChain && (
        <button
          onClick={() => switchChain({ chainId: switchTarget.id })}
          disabled={isSwitching}
          className="btn h-9 border border-amber-400/40 bg-amber-400/10 px-3 py-0 text-xs text-amber-200 hover:bg-amber-400/20"
        >
          {isSwitching ? 'Switching…' : `Switch to ${switchTarget.name}`}
        </button>
      )}
      <button
        onClick={() => disconnect()}
        className="btn-ghost num h-9 px-3 py-0 text-[13px]"
        title={address}
      >
        {shortAddress(address ?? '')}
      </button>
    </div>
  );
}
