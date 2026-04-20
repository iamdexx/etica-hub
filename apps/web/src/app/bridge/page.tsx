export const metadata = { title: 'Bridge · EticaHub' };

export default function BridgePage() {
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Bridge</h1>
      <p className="text-sm text-white/60">
        Lock ETI on Etica, mint wETI on Ethereum (and back). Unlocks Uniswap / 1inch liquidity.
      </p>
      <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-10 text-center text-sm text-white/50">
        <div>Bridge ships in <strong>Phase 3</strong>.</div>
        <div className="mt-2 text-xs text-white/40">
          Requires an audit before handling real TVL — no mainnet deploy until then.
        </div>
      </div>
    </div>
  );
}
