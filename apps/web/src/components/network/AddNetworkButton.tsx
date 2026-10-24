'use client';

import { useState } from 'react';
import { eticaMainnet } from '@etica-hub/shared/chains';

export const ETICA_CHAINLIST_URL = 'https://chainlist.org/chain/61803';

export const ETICA_ADD_CHAIN_PARAMS = {
  chainId: `0x${eticaMainnet.id.toString(16)}`,
  chainName: 'Etica Mainnet',
  nativeCurrency: { name: 'EGAZ', symbol: 'EGAZ', decimals: 18 },
  rpcUrls: ['https://eticamainnet.eticaprotocol.org'],
  blockExplorerUrls: ['https://eticahub.com/explorer'],
  iconUrls: ['https://eticahub.com/brand/eticahub-mark-512.png'],
} as const;

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

function injectedProvider(): Eip1193 | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { ethereum?: Eip1193 }).ethereum;
}

type State = 'idle' | 'pending' | 'added' | 'rejected' | 'error';

/**
 * One-click "Add Etica to MetaMask" (EIP-3085 `wallet_addEthereumChain`).
 * Works with any injected wallet; when no wallet is injected (plain mobile
 * browser) it links to the Chainlist entry, which deep-links into MetaMask.
 */
export function AddNetworkButton({
  className = 'btn-ghost px-5 py-2.5',
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const [state, setState] = useState<State>('idle');

  const add = async () => {
    const eth = injectedProvider();
    if (!eth) {
      window.open(ETICA_CHAINLIST_URL, '_blank', 'noopener,noreferrer');
      return;
    }
    setState('pending');
    try {
      await eth.request({ method: 'wallet_addEthereumChain', params: [ETICA_ADD_CHAIN_PARAMS] });
      setState('added');
    } catch (e) {
      const code = (e as { code?: number } | undefined)?.code;
      setState(code === 4001 ? 'rejected' : 'error');
    }
  };

  const label =
    state === 'pending'
      ? 'Check your wallet…'
      : state === 'added'
        ? 'Etica added ✓'
        : state === 'rejected'
          ? 'Cancelled, try again'
          : state === 'error'
            ? 'Could not add, open Chainlist'
            : compact
              ? 'Add Etica to MetaMask'
              : 'Add Etica to MetaMask';

  return (
    <button
      type="button"
      onClick={state === 'error' ? () => window.open(ETICA_CHAINLIST_URL, '_blank', 'noopener,noreferrer') : add}
      disabled={state === 'pending'}
      className={className}
      data-testid="add-network-button"
    >
      {label}
    </button>
  );
}
