import { StakeView } from '@/components/stake/StakeView';

export const metadata = { title: 'Stake · EticaHub' };

export default function StakePage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Stake ETX</h1>
        <p className="mt-1 text-sm text-white/60">
          Deposit ETX into the stETX vault. Your stETX balance stays fixed, but each share
          redeems for more ETX over time as the keeper harvests treasury swap fees. No
          lockup, no slashing — the exchange rate is monotonically non-decreasing.
        </p>
      </div>
      <StakeView />
    </div>
  );
}
