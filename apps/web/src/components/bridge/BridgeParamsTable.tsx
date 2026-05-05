/**
 * Spec-derived parameter table. Values mirror docs/BRIDGE_CONTRACT_SPEC.md
 * and the parameter lock summary recorded in PR #157. When the bridge goes
 * live, BridgeStatusBoard reads the actual on-chain values; this table
 * documents what the operator committed to at deploy time.
 */
const ROWS: { label: string; value: string; note?: string }[] = [
  { label: 'Architecture', value: 'Optimistic-veto over Hyperlane' },
  { label: 'Asset', value: 'ETX (lock-and-mint to wETX)' },
  { label: 'Chains at launch', value: 'Ethereum + BNB Smart Chain' },
  { label: 'Challenge window', value: '48 hours', note: 'Default-pass; vetoable by operator during window.' },
  { label: 'Submitter bond', value: '25% of claim amount', note: 'Refunded on execute, slashed 25/50/25 prover/treasury/insurance on veto.' },
  { label: 'Bridge fee', value: '0.1%', note: 'Routed 20/80 to insurance fund / harvester via FeeRouter.' },
  { label: 'Initial TVL cap', value: '1,000,000 ETX', note: 'Auto-raises +1M / month after 30 d clean ops, ceiling 10M ETX.' },
  { label: 'Per-claim cap', value: '1% of TVL' },
  { label: 'Daily rate limit', value: '5% of TVL' },
  { label: 'Insurance backstop', value: '10,000,000 ETX', note: 'Pre-funded on Etica before first deposit.' },
  { label: 'Watcher cadence', value: 'heartbeat 15 m / monitor 5 m / execute 30 m', note: 'Free GitHub Actions cron — alert-only, no auto-veto.' },
  { label: 'Successor key timelock', value: '90 days', note: 'Activates only after operator key has been silent for the full window.' },
];

export function BridgeParamsTable() {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="text-xs uppercase tracking-widest text-white/40">Locked parameters</div>
      <div className="mt-3 divide-y divide-white/5 rounded-lg border border-white/5 bg-white/[0.02]">
        {ROWS.map((row) => (
          <div key={row.label} className="grid grid-cols-1 gap-1 px-3 py-2 text-sm sm:grid-cols-3 sm:gap-3">
            <div className="text-white/60">{row.label}</div>
            <div className="font-medium text-white sm:col-span-2">
              {row.value}
              {row.note ? <span className="ml-2 text-xs font-normal text-white/40">{row.note}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
