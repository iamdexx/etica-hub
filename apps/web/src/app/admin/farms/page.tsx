import { AdminFarmsCard } from '@/components/admin/AdminFarmsCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Admin · Farms · EticaHub' };

export default function AdminFarmsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">ETXFarms — Admin</h1>
        <p className="text-sm text-white/60">
          Privileged write operations on the ETXFarms LP staking contract. All buttons are disabled
          unless your connected wallet is the current <span className="font-mono">owner</span>.
          Reads are public and always live.
        </p>
        <p className="text-sm text-amber-300/80">
          Warning: registering pools is a one-way state change. Confirm the LP address + alloc point
          on each row before signing.
        </p>
      </header>
      <AdminFarmsCard />
    </div>
  );
}
