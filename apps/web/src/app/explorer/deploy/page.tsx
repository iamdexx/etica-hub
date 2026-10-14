import Link from 'next/link';
import { ContractDeployForm } from '@/components/explorer/ContractDeployForm';

export const metadata = {
  title: 'Deploy Contract · EticaHub Scan',
};

export default function DeployContractPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <section className="overflow-hidden rounded-xl border border-white/[0.07] bg-[#07120f]">
        <div className="border-b border-white/[0.07] bg-[radial-gradient(circle_at_top,rgba(52,211,153,0.16),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.01))] p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-emerald-300/75">
                EticaHub Scan · Contract Tools
              </div>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white md:text-4xl">
                Deploy Contract
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">
                Compile Solidity source, select a compiled contract, deploy from your connected wallet, and continue directly into Sourcify verification inside the Explorer.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Link href="/explorer" className="btn-ghost px-3.5 py-1.5 text-xs">
                Explorer Home
              </Link>
              <Link href="/explorer/contracts" className="btn-ghost px-3.5 py-1.5 text-xs">
                Contracts
              </Link>
              <Link href="/explorer/verify" className="btn-primary px-3.5 py-1.5 text-xs">
                Verify Contract
              </Link>
            </div>
          </div>
        </div>

        <div className="grid border-b border-white/[0.07] bg-white/[0.015] md:grid-cols-4">
          <Step number="1" title="Write" body="Paste or edit Solidity source." />
          <Step number="2" title="Compile" body="Choose optimizer settings and compile." />
          <Step number="3" title="Deploy" body="Send deployment from your wallet." />
          <Step number="4" title="Verify" body="Submit source to Sourcify." />
        </div>
      </section>

      <ContractDeployForm />
    </div>
  );
}

function Step({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <div className="border-white/[0.07] p-4 md:border-r">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-accent text-xs font-bold text-brand-ink">
          {number}
        </span>
        <span className="text-sm font-semibold text-white">{title}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-white/45">{body}</p>
    </div>
  );
}
