import { DirectWindowsCard } from '@/components/deploy/DirectWindowsCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const dynamic = 'force-dynamic';

export default function DirectWindowsSeedPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Seed the new Direct windows</h1>
        <p className="text-sm text-white/60">
          Whitelisted seeder only. Each window takes about $20 of ETX (two signatures: send, then
          mint); the window buys both legs on the hub and locks them as hub LP. Nothing else needed.
        </p>
      </header>
      <DirectWindowsCard role="seeder" />
    </div>
  );
}
