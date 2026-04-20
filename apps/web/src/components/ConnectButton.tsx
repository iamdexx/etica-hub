'use client';

import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from 'wagmi';
import { eticaMainnet, eticaCrucible, eticaLocalFork } from '@etica-hub/shared/chains';
import { shortAddress } from '@/lib/utils';

const IS_DEV = process.env.NODE_ENV !== 'production';

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

  const onSupportedChain =
    chainId === eticaMainnet.id
    || chainId === eticaCrucible.id
    || (IS_DEV && chainId === eticaLocalFork.id);
  const switchTarget = IS_DEV ? eticaLocalFork : eticaCrucible;

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
