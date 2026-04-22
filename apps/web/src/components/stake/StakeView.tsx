'use client';

import { useChainId } from 'wagmi';
import { DEPLOYMENTS, isSupportedChainId } from '@etica-hub/shared';
import { StakeCard } from './StakeCard';
import { StakeStats } from './StakeStats';
import { StakeRateChart } from './StakeRateChart';

const ZERO = '0x0000000000000000000000000000000000000000';

export function StakeView() {
  const chainId = useChainId();
  const supported = isSupportedChainId(chainId);
  const stakedETX = supported ? DEPLOYMENTS[chainId].stakedETX : ZERO;
  const etx = supported ? DEPLOYMENTS[chainId].etx : ZERO;
  const deployed = stakedETX !== ZERO && etx !== ZERO;

  if (!supported) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-200/80">
        Unsupported chain. Switch to Etica mainnet (61803) to stake.
      </div>
    );
  }

  if (!deployed) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-sm text-white/70">
          <div className="mb-1 text-base font-semibold text-white">stETX not deployed yet</div>
          <p>
            The stETX vault has not been deployed on this chain. Operators can deploy it at{' '}
            <a href="/deploy/stetx" className="text-brand-accent hover:underline">
              /deploy/stetx
            </a>{' '}
            and then paste the address into{' '}
            <span className="font-mono">packages/shared/src/addresses.ts</span>.
          </p>
          <p className="mt-2 text-white/50">
            Once deployed, this page will light up with live deposit, withdraw, APY and
            exchange-rate history.
          </p>
        </div>
        <StakeHowItWorks />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StakeStats stakedETX={stakedETX} />
      <StakeCard stakedETX={stakedETX} etx={etx} />
      <StakeRateChart stakedETX={stakedETX} />
      <StakeHowItWorks />
    </div>
  );
}

function StakeHowItWorks() {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-xs text-white/50">
      <div className="font-medium text-white/70">How stETX works</div>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        <li>
          Deposit ETX → receive stETX shares at the current exchange rate. No lockup; you
          can redeem any time.
        </li>
        <li>
          A daily keeper harvests treasury LP fees on ETI/ETX and WEGAZ/ETX pools, swaps
          the non-ETX leg to ETX, and calls <span className="font-mono">distributeRewards</span> on
          the vault. Every call grows <span className="font-mono">pricePerShare</span>.
        </li>
        <li>
          Exchange rate is structurally non-decreasing: there is no slashing path, no
          strategy risk, no admin function that can remove assets without burning shares.
        </li>
        <li>
          stETX is a plain ERC-20 with EIP-2612 permit support. Can be listed on the AMM,
          used as collateral, transferred freely.
        </li>
      </ul>
    </div>
  );
}
