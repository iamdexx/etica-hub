import Link from 'next/link';
import { explorerClient, formatAgo } from '@/lib/explorer';
import {
  loadGasStats,
  formatGwei,
  GAS_STATS_WINDOW,
} from '@/lib/gas';
import { GasChart } from '@/components/explorer/GasChart';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Gas tracker · Etica Explorer',
  description:
    'Current gas price, base fee, and recent block utilization on Etica Mainnet.',
};

export default async function GasTrackerPage() {
  const client = explorerClient();
  const stats = await loadGasStats(client);

  const { blocks } = stats;
  const tail = blocks.slice(-12).reverse();

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <Link
          href="/explorer"
          className="text-xs uppercase tracking-wider text-white/50 hover:text-white/80"
        >
          ← Back to explorer
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Gas tracker
        </h1>
        <p className="max-w-2xl text-sm text-white/70">
          Live gas price + base-fee time series over the last
          {' '}{GAS_STATS_WINDOW} blocks on Etica Mainnet. Read-only,
          served straight from RPC.
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-4">
        <StatCard
          label="Current gas price"
          value={`${formatGwei(stats.currentGasPriceWei)} gwei`}
          hint="eth_gasPrice — what a wallet would quote right now"
        />
        <StatCard
          label="Head base fee"
          value={`${formatGwei(stats.headBaseFeeWei)} gwei`}
          hint={stats.headBaseFeeWei == null ? 'Pre-1559' : 'EIP-1559 floor at the head block'}
        />
        <StatCard
          label="Avg base fee (window)"
          value={`${formatGwei(stats.avgBaseFeeWei)} gwei`}
          hint={`${stats.blocks.length} block window`}
        />
        <StatCard
          label="Network load"
          value={`${(stats.avgGasUsedRatio * 100).toFixed(1)}%`}
          hint="avg gas used / gas limit"
        />
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Base fee, last {stats.blocks.length} blocks</h2>
          <span className="text-xs text-white/40">
            min {formatGwei(stats.minBaseFeeWei)} · max {formatGwei(stats.maxBaseFeeWei)} gwei
          </span>
        </div>
        <GasChart blocks={stats.blocks} />
        <p className="mt-2 text-xs text-white/40">
          Line = base fee per gas (gwei). Bars = gas used / gas limit. Hover a
          column for per-block detail.
        </p>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="mb-3 text-lg font-semibold">Recent blocks</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-white/40">
              <tr>
                <th className="py-2 pr-3">Block</th>
                <th className="py-2 pr-3">Age</th>
                <th className="py-2 pr-3">Txs</th>
                <th className="py-2 pr-3">Base fee</th>
                <th className="py-2 pr-3">Avg priority</th>
                <th className="py-2 pr-3">Used</th>
              </tr>
            </thead>
            <tbody>
              {tail.map((b) => {
                const ratio =
                  b.gasLimit > 0n
                    ? Number(b.gasUsed) / Number(b.gasLimit)
                    : 0;
                return (
                  <tr key={b.number.toString()} className="border-t border-white/5">
                    <td className="py-2 pr-3 font-mono">
                      <Link
                        href={`/explorer/block/${b.number}`}
                        className="text-brand-accent hover:underline"
                      >
                        #{b.number.toString()}
                      </Link>
                    </td>
                    <td className="py-2 pr-3 text-xs text-white/50">
                      {formatAgo(b.timestamp)}
                    </td>
                    <td className="py-2 pr-3 text-white/70">{b.txCount}</td>
                    <td className="py-2 pr-3 text-white/70">
                      {formatGwei(b.baseFeePerGasWei)} gwei
                    </td>
                    <td className="py-2 pr-3 text-white/70">
                      {formatGwei(b.avgPriorityFeeWei)} gwei
                    </td>
                    <td className="py-2 pr-3 text-white/70">
                      {(ratio * 100).toFixed(0)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <p className="text-xs uppercase tracking-wider text-white/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint ? <p className="mt-1 text-xs text-white/40">{hint}</p> : null}
    </div>
  );
}
