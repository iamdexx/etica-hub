'use client';

import { useState } from 'react';

export const WALLET_TOKENS = {
  ETX: {
    address: '0xa5A1Bc6307b0b87989B8456D4b35F88a68650044',
    symbol: 'ETX',
    decimals: 18,
    image: 'https://eticahub.com/logos/etx.png',
  },
  stETX: {
    address: '0x75d81d03a98CD9195593b8963aF17E13fAa70334',
    symbol: 'stETX',
    decimals: 18,
    image: 'https://eticahub.com/logos/stetx.png',
  },
  'USDC.e': {
    address: '0x0BA5C0BFd034639330d2CF9DBAD354d8DBc2d335',
    symbol: 'USDC.e',
    decimals: 6,
    image: 'https://eticahub.com/logos/usdc.png',
  },
} as const;

export type WalletTokenSymbol = keyof typeof WALLET_TOKENS;

type Eip1193 = { request: (args: { method: string; params?: unknown }) => Promise<unknown> };

/** EIP-747 `wallet_watchAsset`: adds the token with its logo to the connected wallet. */
export function AddTokenButton({
  token,
  className = 'btn px-3 text-white/60 hover:text-white',
}: {
  token: WalletTokenSymbol;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const t = WALLET_TOKENS[token];

  const add = async () => {
    const eth =
      typeof window === 'undefined'
        ? undefined
        : (window as Window & { ethereum?: Eip1193 }).ethereum;
    if (!eth) {
      window.open('https://eticahub.com/tokenlist.json', '_blank', 'noopener,noreferrer');
      return;
    }
    setState('pending');
    try {
      await eth.request({
        method: 'wallet_watchAsset',
        params: { type: 'ERC20', options: t },
      });
      setState('done');
    } catch {
      setState('error');
    }
  };

  return (
    <button
      type="button"
      onClick={add}
      disabled={state === 'pending'}
      className={className}
      data-testid={`add-token-${t.symbol}`}
    >
      {state === 'done' ? `${t.symbol} added ✓` : state === 'error' ? `Retry ${t.symbol}` : `+ ${t.symbol}`}
    </button>
  );
}
