import { PoolAddCard } from '@/components/pool/PoolAddCard';
import { PoolPositionsList } from '@/components/pool/PoolPositionsList';

export const metadata = { title: 'Pool · EticaHub' };

export default function PoolPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Liquidity pools</h1>
        <p className="mt-1 text-sm text-white/60">
          Add and remove liquidity on EticaSwap V2 pairs. Every swap pays 0.25% to LPs; you
          earn proportionally to your share of the pool.
        </p>
      </div>
      <PoolAddCard />
      <PoolPositionsList />
      <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-xs text-white/50">
        <div className="font-medium text-white/70">How it works</div>
        <ul className="mt-1 list-disc pl-5 space-y-1">
          <li>
            Pools pair ETX with any ERC20 (ETI, EGAZ, or a custom token). ETX is the hub
            token — non-ETX pairs are rejected at the factory.
          </li>
          <li>
            Creating a new pool costs <strong>10,000 ETX</strong>, paid to the EticaHub
            treasury. Adding to an existing pool is free (just gas).
          </li>
          <li>
            Deposits must match the current pool ratio. For new pools the ratio you set becomes
            the initial price.
          </li>
          <li>
            LP positions are ERC20 tokens. You can withdraw your share any time by removing
            liquidity below.
          </li>
        </ul>
      </div>
    </div>
  );
}
