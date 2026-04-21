import { notFound } from 'next/navigation';
import { AdminReactorCard } from '@/components/admin/AdminReactorCard';
import { operatorUiEnabled } from '@/lib/operatorUi';

export const metadata = { title: 'Admin · Reactor · EticaHub' };

export default function AdminReactorPage() {
  if (!operatorUiEnabled()) notFound();
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">UniswapX Reactor — Admin</h1>
        <p className="text-sm text-white/60">
          Privileged write operations on the DutchOrderReactor + EticaProtocolFeeController.
          Controller writes are disabled unless your connected wallet is the current{' '}
          <span className="font-mono">controller.owner()</span>;{' '}
          <span className="font-mono">setProtocolFeeController</span> is additionally gated behind
          the reactor&apos;s own owner.
        </p>
        <p className="text-sm text-amber-300/80">
          Warning: these calls change on-chain protocol parameters. Verify the current state below
          before signing.
        </p>
      </header>
      <AdminReactorCard />
    </div>
  );
}
