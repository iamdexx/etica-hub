import Link from 'next/link';
import { ContractDeployForm } from '@/components/explorer/ContractDeployForm';

export const dynamic = 'force-dynamic';

export default function DeployContractPage() {
  return (
    <div className="space-y-6">
      <nav className="text-xs text-white/50">
        <Link href="/explorer" className="hover:underline">
          Explorer
        </Link>
        <span className="px-1">/</span>
        <span>Deploy contract</span>
      </nav>

      <section className="overflow-hidden rounded-3xl border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.18),transparent_40%),rgba(255,255,255,0.02)] p-6 md:p-8">
        <div className="max-w-3xl space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-emerald-300">
            Public RPC deployer
          </div>
          <h1 className="text-3xl font-semibold tracking-tight md:text-5xl">
            Deploy contracts from <span className="text-brand-accent">EticaHub Scan</span>
          </h1>
          <p className="text-sm leading-6 text-white/70 md:text-base">
            Deploy raw creation bytecode with your connected wallet, then verify the result through
            Sourcify. This stays lightweight: no backend keys, no private RPC requirement, and no
            heavy explorer indexer dependency.
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            <Link href="/explorer/verify" className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 hover:text-white">
              Verify contract →
            </Link>
            <Link href="/explorer/contracts" className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 hover:text-white">
              Browse contracts →
            </Link>
          </div>
        </div>
      </section>

      <ContractDeployForm />
    </div>
  );
}
