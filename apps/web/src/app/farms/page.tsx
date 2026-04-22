import { FarmsView } from '@/components/farms/FarmsView';

export const metadata = { title: 'Farms · EticaHub' };

export default function FarmsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">LP Farms</h1>
        <p className="mt-1 text-sm text-white/60">
          Stake EticaSwap ETI/ETX or EGAZ/ETX LP tokens to earn a pro-rata share of the 10%
          farms slice of every Treasury Harvester cycle. No emissions, no lockup — rewards come
          strictly from redistributed protocol fees.
        </p>
      </div>
      <FarmsView />
    </div>
  );
}
