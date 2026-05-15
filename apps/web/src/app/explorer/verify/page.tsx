import { SourcifyVerifyForm } from '@/components/explorer/SourcifyVerifyForm';

export const dynamic = 'force-dynamic';

interface VerifyContractPageProps {
  searchParams?: Promise<{ address?: string }>;
}

export default async function VerifyContractPage({ searchParams }: VerifyContractPageProps) {
  const params = (await searchParams) ?? {};
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
            Once matched, contract pages can show source tabs, ABI decoding, and interaction panels.
          </p>
        </div>
      </section>

      <SourcifyVerifyForm defaultAddress={params.address ?? ''} />
    </div>
  );
}
