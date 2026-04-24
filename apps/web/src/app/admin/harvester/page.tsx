import { AdminHarvesterCard } from '@/components/admin/AdminHarvesterCard';
import { HarvestNowCard } from '@/components/admin/HarvestNowCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Admin · Harvester · EticaHub' };

export default function AdminHarvesterPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">TreasuryHarvester — Admin</h1>
        <p className="text-sm text-white/60">
          Privileged write operations on the TreasuryHarvester. All buttons are disabled unless your
          connected wallet is the current <span className="font-mono">owner</span>. Reads are public
          and always live.
        </p>
        <p className="text-sm text-amber-300/80">
          Warning: these calls wire the 10% staking + 10% farms slices and grant LP spend
          allowances. Verify current state before signing.
        </p>
      </header>
      <HarvestNowCard />
      <AdminHarvesterCard />
    </div>
  );
}
