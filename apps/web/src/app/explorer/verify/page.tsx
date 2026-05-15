import { SourcifyVerifyForm } from '@/components/explorer/SourcifyVerifyForm';

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
            <Feature
              title="Full source rendering"
              body="Verified Solidity source becomes visible directly inside explorer contract pages."
            />
            <Feature
              title="Decoded calls and logs"
              body="ABI-aware decoding activates automatically across transaction and event views."
            />
            <Feature
              title="Public reproducibility"
              body="Verification remains independently reproducible through Sourcify bytecode matching."
            />
          </div>
        </div>
      </section>

      <SourcifyVerifyForm />
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
