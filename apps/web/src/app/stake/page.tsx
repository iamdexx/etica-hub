import Link from 'next/link';
import { PageHero } from '@/components/PageHero';
import { DEPLOYMENTS } from '@etica-hub/shared';
import { StakeView } from '@/components/stake/StakeView';
import { ContractAddressChip } from '@/components/ContractAddressChip';

export const metadata = { title: 'Stake · EticaHub' };

const VAULT_STATS = [
  ['Asset', 'ETX → stETX'],
  ['Lockup', 'None'],
  ['Slashing', 'None'],
  ['Rate path', 'Non-decreasing'],
];

export default function StakePage() {
  const stakedETX = DEPLOYMENTS[61803].stakedETX;
  return (
    <div className="space-y-6">
      <PageHero
        tone="indigo"
        eyebrow="stETX Vault Terminal"
        title="Stake ETX into an appreciating vault share."
        description="Deposit ETX, receive stETX, and keep the vault address, exchange-rate model, and liquidity routes visible beside the staking controls."
        actions={
          <>
            <Link href="/pool" className="btn-tone px-3.5 py-1.5 text-xs">
              stETX/ETX pool
            </Link>
            <Link href="/farms" className="btn-ghost px-3.5 py-1.5 text-xs">
              Farm LP
            </Link>
            <Link href="/explorer/tokens" className="btn-primary px-3.5 py-1.5 text-xs">
              Token analytics
            </Link>
          </>
        }
        aside={
          <div className="surface p-4">
            <div className="text-[11px] uppercase tracking-eyebrow text-white/45">
              Vault summary
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
              {VAULT_STATS.map(([label, value]) => (
                <div key={label} className="surface-2 p-3">
                  <div className="text-[10px] uppercase tracking-eyebrow text-white/40">
                    {label}
                  </div>
                  <div className="mt-1 text-xs font-medium text-white/80">{value}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-5 text-white/45">
              These are vault mechanics, not a simulated chart. Live staking state belongs in the
              connected staking panel below.
            </p>
          </div>
        }
      >
        <ContractAddressChip label="stETX vault" address={stakedETX} className="mt-3" />
      </PageHero>

      <section className="grid gap-6 lg:grid-cols-[0.7fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <div className="surface p-5">
            <div className="text-[11px] uppercase tracking-eyebrow text-white/45">
              Vault mechanics
            </div>
            <div className="mt-4 space-y-3">
              <InfoCard
                title="No lockup"
                body="Stake and unstake through the existing vault controls. stETX is designed as a liquid staking share, not a time-locked position."
              />
              <InfoCard
                title="Harvest-backed rate"
                body="Keeper harvests route treasury swap fees into the vault, lifting the ETX redemption value per stETX share over time."
              />
              <InfoCard
                title="Liquidity route"
                body="Use the stETX/ETX pool and farms to manage liquid exposure around the staking vault."
              />
            </div>
          </div>
          <div className="surface px-4 py-3 text-xs leading-5 text-white/50">
            <div className="font-medium text-white/70">Risk note</div>
            <p className="mt-1">
              The exchange rate is designed to be monotonically non-decreasing, but staking and
              unstaking still depend on connected-wallet execution, vault liquidity, and
              smart-contract availability.
            </p>
          </div>
        </aside>

        <div className="surface p-3">
          <StakeView />
        </div>
      </section>
    </div>
  );
}

function InfoCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="surface-2 p-4">
      <div className="text-sm font-semibold text-white">{title}</div>
      <p className="mt-2 text-xs leading-5 text-white/55">{body}</p>
    </div>
  );
}
