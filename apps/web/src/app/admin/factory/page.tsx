import { AdminFactoryCard } from '@/components/admin/AdminFactoryCard';

export const metadata = { title: 'Admin · Factory · EticaHub' };

export default function AdminFactoryPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">EticaSwap Factory — Admin</h1>
        <p className="text-sm text-white/60">
          Privileged write operations on the EticaSwap V2 factory. All buttons are disabled unless
          your connected wallet is the current <span className="font-mono">feeToSetter</span>. Reads
          on the factory are public and always live.
        </p>
        <p className="text-sm text-amber-300/80">
          Warning: these calls change on-chain protocol parameters. Verify the current state above
          before signing.
        </p>
      </header>
      <AdminFactoryCard />
    </div>
  );
}
