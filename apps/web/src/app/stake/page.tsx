import Link from 'next/link';
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

const RATE_BARS = [42, 50, 58, 61, 70, 76, 86, 91, 104, 110, 119, 128];

export default function StakePage() {
  const stakedETX = DEPLOYMENTS[61803].stakedETX;
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-indigo-400/20 bg-[#080914] shadow-2xl shadow-indigo-950/20">
        <div className="grid gap-6 border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(129,140,248,0.2),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.01))] p-5 lg:grid-cols-[1fr_0.82fr] lg:p-6">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-indigo-400/30 bg-indigo-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-indigo-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-300" />
              stETX Vault Terminal
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">Stake ETX into an appreciating vault share.</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
                Deposit ETX, receive stETX, and keep the vault address, exchange-rate model, and liquidity routes visible beside the staking controls. Your stETX balance stays fixed while each share redeems for more ETX as harvests accrue.
              </p>
            </div>
            <ContractAddressChip label="stETX vault" address={stakedETX} className="mt-3" />
            <div className="flex flex-wrap gap-2 text-xs">
              <Link href="/pool" className="rounded-md border border-indigo-400/25 bg-indigo-400/10 px-3 py-2 text-indigo-100 hover:bg-indigo-400/15">stETX/ETX pool</Link>
              <Link href="/farms" className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white/75 hover:bg-white/10">Farm LP</Link>
              <Link href="/explorer/tokens" className="rounded-md bg-brand-accent px-3 py-2 font-medium text-brand-ink hover:opacity-90">Token analytics</Link>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="flex items-center justify-between text-xs">
              <span className="uppercase tracking-wider text-white/40">Exchange-rate path</span>
              <span className="text-indigo-200">vault monitor</span>
            </div>
            <div className="mt-4 flex h-36 items-end gap-2 rounded-xl border border-white/10 bg-black/30 p-3">
              {RATE_BARS.map((height, index) => (
                <div key={index} className="flex flex-1 flex-col items-center justify-end gap-1">
                  <span className="w-full rounded-t bg-indigo-300/70" style={{ height }} />
                  <span className="h-1 w-full rounded bg-white/15" />
                </div>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {VAULT_STATS.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
                  <div className="mt-1 text-xs font-medium text-white/80">{value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.7fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-5">
            <div className="text-xs uppercase tracking-wider text-white/40">Vault mechanics</div>
            <div className="mt-4 space-y-3">
              <InfoCard title="No lockup" body="Stake and unstake through the existing vault controls. stETX is designed as a liquid staking share, not a time-locked position." />
              <InfoCard title="Harvest-backed rate" body="Keeper harvests route treasury swap fees into the vault, lifting the ETX redemption value per stETX share over time." />
              <InfoCard title="Liquidity route" body="Use the stETX/ETX pool and farms to manage liquid exposure around the staking vault." />
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3 text-xs leading-5 text-white/50">
            <div className="font-medium text-white/70">Risk note</div>
            <p className="mt-1">The exchange rate is designed to be monotonically non-decreasing, but staking and unstaking still depend on connected-wallet execution, vault liquidity, and smart-contract availability.</p>
          </div>
        </aside>

        <div className="rounded-2xl border border-indigo-400/20 bg-white/[0.03] p-3 shadow-xl shadow-indigo-950/20">
          <StakeView />
        </div>
      </section>
    </div>
  );
}

function InfoCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/25 p-4">
      <div className="text-sm font-semibold text-white">{title}</div>
      <p className="mt-2 text-xs leading-5 text-white/55">{body}</p>
    </div>
  );
}
