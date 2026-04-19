export const metadata = { title: 'Pool · EticaHub' };

export default function PoolPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Liquidity pools</h1>
      <p className="text-sm text-white/60">
        Add and remove liquidity on EticaSwap V2 pairs. Earn 0.25% of every swap on your pool.
      </p>
      <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-10 text-center text-sm text-white/50">
        Pool UI ships alongside the first testnet deploy.
      </div>
    </div>
  );
}
