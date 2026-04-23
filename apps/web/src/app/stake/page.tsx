import { DEPLOYMENTS } from '@etica-hub/shared';
import { StakeView } from '@/components/stake/StakeView';
import { ContractAddressChip } from '@/components/ContractAddressChip';

export const metadata = { title: 'Stake · EticaHub' };

export default function StakePage() {
  const stakedETX = DEPLOYMENTS[61803].stakedETX;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Stake ETX</h1>
        <p className="mt-1 text-sm text-white/60">
          Deposit ETX into the stETX vault. Your stETX balance stays fixed, but each share redeems
          for more ETX over time as the keeper harvests treasury swap fees. No lockup, no slashing —
          the exchange rate is monotonically non-decreasing.
        </p>
        <ContractAddressChip label="stETX vault" address={stakedETX} className="mt-3" />
      </div>
      <StakeView />
    </div>
  );
}
