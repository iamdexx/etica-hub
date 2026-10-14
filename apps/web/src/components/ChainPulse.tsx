'use client';

import { useEffect, useRef, useState } from 'react';
import { useBlockNumber } from 'wagmi';
import { eticaMainnet } from '@etica-hub/shared/chains';
import { cn } from '@/lib/utils';

/** Live block counter that flashes on every new head; wallet-less, public RPC. */
export function ChainPulse({ className }: { className?: string }) {
  const { data: head } = useBlockNumber({ chainId: eticaMainnet.id, watch: true });
  const [flash, setFlash] = useState(false);
  const last = useRef<bigint | undefined>(undefined);

  useEffect(() => {
    if (head === undefined || head === last.current) return;
    last.current = head;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 600);
    return () => clearTimeout(t);
  }, [head]);

  return (
    <div className={cn('inline-flex items-center gap-2.5 text-xs text-white/55', className)}>
      <span className="live-dot" />
      <span>Etica mainnet</span>
      <span className="text-white/25">·</span>
      <span
        className={cn(
          'num transition-colors duration-500',
          flash ? 'text-brand-glow' : 'text-white/80',
        )}
      >
        {head === undefined ? 'syncing…' : `#${head.toLocaleString('en-US')}`}
      </span>
    </div>
  );
}
