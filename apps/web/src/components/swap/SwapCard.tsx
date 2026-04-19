'use client';

import { useAccount } from 'wagmi';
import { DEPLOYMENTS } from '@etica-hub/shared';
import { useMemo } from 'react';

/**
 * Placeholder swap card. Wired to the shared config so it already knows
 * when the router address is missing on the current chain. Full swap
 * math + approvals land in a follow-up PR.
 */
export function SwapCard() {
  const { chainId, isConnected } = useAccount();

  const deployed = useMemo(() => {
    if (!chainId) return null;
    const dep = DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS];
    if (!dep) return null;
    return dep.swapRouter !== '0x0000000000000000000000000000000000000000' ? dep : null;
  }, [chainId]);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-white/70">Swap</h2>
        <span className="text-xs text-white/40">v2</span>
      </div>

      <div className="mt-4 space-y-2">
        <div className="rounded-xl border border-white/10 bg-black/30 p-4">
          <div className="flex items-center justify-between">
            <input
              disabled
              placeholder="0.0"
              className="w-full bg-transparent text-2xl outline-none placeholder:text-white/30 disabled:cursor-not-allowed"
            />
            <button
              disabled
              className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm disabled:cursor-not-allowed"
            >
              EGAZ
            </button>
          </div>
          <div className="mt-1 text-xs text-white/40">Balance: —</div>
        </div>

        <div className="flex justify-center">
          <button
            disabled
            className="rounded-full border border-white/10 bg-white/10 p-2 text-white/70 disabled:cursor-not-allowed"
          >
            ↓
          </button>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/30 p-4">
          <div className="flex items-center justify-between">
            <input
              disabled
              placeholder="0.0"
              className="w-full bg-transparent text-2xl outline-none placeholder:text-white/30 disabled:cursor-not-allowed"
            />
            <button
              disabled
              className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm disabled:cursor-not-allowed"
            >
              ETI
            </button>
          </div>
          <div className="mt-1 text-xs text-white/40">Balance: —</div>
        </div>
      </div>

      <button
        disabled
        className="mt-4 w-full rounded-xl bg-brand-accent/80 py-3 font-medium text-brand-ink disabled:opacity-50"
      >
        {!isConnected
          ? 'Connect wallet to continue'
          : !deployed
            ? 'EticaSwap not yet deployed on this chain'
            : 'Swap'}
      </button>

      <p className="mt-3 text-xs text-white/40">
        The swap flow (quote, approval, slippage, price impact) is wired into the contracts under
        <code className="mx-1 rounded bg-white/5 px-1 py-0.5">packages/contracts/src/swap</code>
        and ships with the testnet deploy in the next PR.
      </p>
    </div>
  );
}
