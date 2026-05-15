import Link from 'next/link';
import { ContractDeployForm } from '@/components/explorer/ContractDeployForm';

export const metadata = {
  title: 'Deploy Contract · EticaHub Explorer',
};

export default function DeployContractPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <section className="space-y-3">
        <div className="inline-flex items-center gap-2 rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-3 py-1 text-xs uppercase tracking-wider text-fuchsia-200">
          Native EticaHub deployment
        </div>
        <h1 className="text-4xl font-semibold tracking-tight">Deploy contracts on Etica</h1>
        <p className="max-w-3xl text-sm text-white/65">
          Paste bytecode + ABI from Remix, Hardhat, Foundry, or Solc and deploy directly to Etica Mainnet from your connected wallet.
        </p>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link href="/explorer" className="rounded-full border border-white/10 bg-white/5 px-4 py-2 hover:bg-white/10">
            Explorer home
          </Link>
          <Link href="/explorer/contracts" className="rounded-full border border-white/10 bg-white/5 px-4 py-2 hover:bg-white/10">
            Contracts
          </Link>
        </div>
      </section>

      <ContractDeployForm />
    </div>
  );
}
