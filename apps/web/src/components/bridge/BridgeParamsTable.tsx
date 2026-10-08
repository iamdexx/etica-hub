/**
 * Deployed USDC.e route parameters (Bridge deploy run 37690097436). Values
 * mirror infra/hyperlane/registry/deployments/warp_routes/USDC/etica-config.yaml
 * and docs/HYPERLANE_USDC_RUNBOOK.md; UsdcRouteStatusBoard reads live state.
 */
const ROWS: { label: string; value: string; note?: string }[] = [
  { label: 'Architecture', value: 'Hyperlane warp route', note: 'HypERC20Collateral on Ethereum, HypERC20 (USDC.e) on Etica.' },
  { label: 'Asset', value: 'USDC → USDC.e (6 decimals)', note: '1:1 lock-and-mint; Circle USDC stays in the collateral router.' },
  { label: 'Chains', value: 'Ethereum mainnet + Etica (61803)' },
  { label: 'Fee, Ethereum → Etica', value: '0.5%', note: 'Capped at 50 USDC per transfer.' },
  { label: 'Fee, Etica → Ethereum', value: '2 USDC.e + 0.5%', note: 'Capped at 50 USDC.e per transfer.' },
  { label: 'Fee destination', value: 'Keeper', note: 'Pays relayer gas and gas drops, keeps a 500 float, converts the rest to EGAZ.' },
  { label: 'Release cap', value: '5,000 USDC / 24h', note: 'Rate-limited USDC release on Ethereum; owner-adjustable.' },
  { label: 'Security', value: 'Validator-signed checkpoints', note: 'Single validator at launch, RPC quorum; guardian can pause both routers.' },
  { label: 'Owner', value: 'Treasury', note: 'Admin only (ISM, cap, upgrades); earns no fees. Transferable to a Safe.' },
  { label: 'Gas drop', value: '2 EGAZ', note: 'Once per recipient that lands USDC.e with an empty EGAZ balance.' },
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
