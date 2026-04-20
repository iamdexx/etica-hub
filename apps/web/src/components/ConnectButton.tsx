'use client';

import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from 'wagmi';
import { eticaMainnet, eticaCrucible } from '@etica-hub/shared/chains';
import { shortAddress } from '@/lib/utils';

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  if (!isConnected) {
    const injected = connectors.find((c) => c.id === 'injected') ?? connectors[0];
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

  const onEtica = chainId === eticaMainnet.id || chainId === eticaCrucible.id;

  return (
    <div className="flex items-center gap-2">
      {!onEtica && (
        <button
          onClick={() => switchChain({ chainId: eticaCrucible.id })}
          disabled={isSwitching}
          className="rounded-full border border-yellow-500/40 bg-yellow-500/10 px-3 py-1.5 text-xs font-medium text-yellow-300 hover:bg-yellow-500/20 disabled:opacity-50"
        >
          {isSwitching ? 'Switching…' : 'Switch to Crucible'}
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
