export const dynamic = 'force-dynamic';

export default function VerifyContractPage() {
  return (
    <div className="space-y-6">
      <nav className="text-xs text-white/50">
        <span>Explorer</span>
        <span className="px-1">/</span>
        <span>Verify contract</span>
      </nav>

      <section className="overflow-hidden rounded-3xl border border-emerald-400/20 bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.18),transparent_40%),rgba(255,255,255,0.02)] p-6 md:p-8">
        <div className="max-w-3xl space-y-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-emerald-300">
              Sourcify verification
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight md:text-5xl">
              Verify contracts on <span className="text-brand-accent">EticaHub Explorer</span>
            </h1>
          </div>

          <p className="text-sm leading-6 text-white/70 md:text-base">
            Submit standard-json compiler input directly to Sourcify from the Explorer.
            Once verified, contracts render with verified source tabs, ABI decoding, and
            explorer-native interaction panels.
          </p>

          <div className="grid gap-4 md:grid-cols-3">
            <Feature title="Full source rendering" body="Verified Solidity source becomes visible directly inside explorer contract pages." />
            <Feature title="Decoded calls and logs" body="ABI-aware decoding activates automatically across transaction and event views." />
            <Feature title="Public reproducibility" body="Verification remains independently reproducible through Sourcify bytecode matching." />
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Verification request</h2>
            <p className="mt-1 text-sm text-white/55">
              Etica mainnet defaults to chain 61803.
            </p>
          </div>
          <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/60">
            Powered by Sourcify
          </div>
        </div>

        <form className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Contract address">
              <input
                placeholder="0x..."
                className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder-white/35 focus:border-brand-accent focus:outline-none"
              />
            </Field>

            <Field label="Chain ID">
              <input
                defaultValue="61803"
                className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder-white/35 focus:border-brand-accent focus:outline-none"
              />
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Compiler version">
              <input
                placeholder="v0.8.24+commit.e11b9ed9"
                className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder-white/35 focus:border-brand-accent focus:outline-none"
              />
            </Field>

            <Field label="Contract identifier">
              <input
                placeholder="contracts/MyContract.sol:MyContract"
                className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder-white/35 focus:border-brand-accent focus:outline-none"
              />
            </Field>
          </div>

          <Field label="Creation transaction hash (optional)">
            <input
              placeholder="0x..."
              className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder-white/35 focus:border-brand-accent focus:outline-none"
            />
          </Field>

          <Field label="Standard JSON compiler input">
            <textarea
              rows={18}
              placeholder='{"language":"Solidity","sources":{...},"settings":{...}}'
              className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-4 font-mono text-xs text-white placeholder-white/30 focus:border-brand-accent focus:outline-none"
            />
          </Field>

          <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs leading-5 text-white/50">
              Verification submissions are forwarded through the EticaHub Explorer API
              layer to Sourcify. Matching contracts automatically gain verified status
              inside explorer pages.
            </div>

            <button
              type="button"
              className="rounded-xl bg-brand-accent px-5 py-3 text-sm font-semibold text-brand-ink hover:opacity-90"
            >
              Submit verification
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="text-sm font-semibold text-white">{title}</div>
      <p className="mt-2 text-xs leading-5 text-white/55">{body}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <div className="text-xs uppercase tracking-wider text-white/45">{label}</div>
      {children}
    </label>
  );
}
