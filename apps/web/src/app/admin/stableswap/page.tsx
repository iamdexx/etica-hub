import { AdminStableSwapCard } from '@/components/admin/AdminStableSwapCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Admin · StableSwap · EticaHub' };

export default function AdminStableSwapPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">StableSwap operator dashboard</h1>
        <p className="text-sm text-white/60">
          Live pool state, permissionless admin-fee claim and harvest, and treasury-only writes
          for the rate-aware stETX/ETX stableswap. Public LPs use{' '}
          <a className="text-emerald-400 hover:underline" href="/pool">
            /pool
          </a>{' '}
          to add or remove liquidity — they hold their own esLP shares with no lock and no fee
          impact from this page.
        </p>
      </header>
      <AdminStableSwapCard />
    </div>
  );
}
