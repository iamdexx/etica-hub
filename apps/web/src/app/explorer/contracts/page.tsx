import Link from 'next/link';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES } from '@etica-hub/shared';
import { addressLabel, explorerClient, shortAddress } from '@/lib/explorer';
import { loadVerified } from '@/lib/verified';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const MAINNET_CHAIN_ID = 61803;
const ZERO = '0x0000000000000000000000000000000000000000';

type ContractRow = {
  address: `0x${string}`;
  name: string;
  group: string;
  description: string;
};

function knownContracts(): ContractRow[] {
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  const ext = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];
  const rows: Array<ContractRow | null> = [
    d?.etx && d.etx !== ZERO ? { address: d.etx, name: 'ETX Token', group: 'Token', description: 'EticaHub reward asset' } : null,
    d?.wegaz && d.wegaz !== ZERO ? { address: d.wegaz, name: 'Wrapped EGAZ', group: 'Token', description: 'Wrapped native gas token' } : null,
    ext?.eti && ext.eti !== ZERO ? { address: ext.eti, name: 'ETI Token', group: 'Token', description: 'Etica protocol token' } : null,
    d?.swapFactory && d.swapFactory !== ZERO ? { address: d.swapFactory, name: 'EticaSwap Factory', group: 'DEX', description: 'Pair factory' } : null,
    d?.swapRouter && d.swapRouter !== ZERO ? { address: d.swapRouter, name: 'EticaSwap Router', group: 'DEX', description: 'Swap and liquidity router' } : null,
    d?.researchSubscription && d.researchSubscription !== ZERO ? { address: d.researchSubscription, name: 'Research Subscription', group: 'Research', description: 'Research Hub access' } : null,
    d?.permit2 && d.permit2 !== ZERO ? { address: d.permit2, name: 'Permit2', group: 'Trading', description: 'Permit approvals' } : null,
    d?.dutchReactor && d.dutchReactor !== ZERO ? { address: d.dutchReactor, name: 'DutchOrderReactor', group: 'Trading', description: 'Order execution' } : null,
    d?.etxFeeController && d.etxFeeController !== ZERO ? { address: d.etxFeeController, name: 'ETX Fee Controller', group: 'Protocol', description: 'Protocol fee configuration' } : null,
    d?.orderRegistry && d.orderRegistry !== ZERO ? { address: d.orderRegistry, name: 'OrderRegistry', group: 'Trading', description: 'Order state registry' } : null,
  ];
  return rows.filter(Boolean) as ContractRow[];
}

export default async function ContractsPage() {
  const client = explorerClient();
  const rows = await Promise.all(
    knownContracts().map(async (contract) => {
      const code = await client.getCode({ address: contract.address }).catch(() => undefined);
      return {
        ...contract,
        verified: loadVerified(contract.address),
        deployed: typeof code === 'string' && code !== '0x',
      };
    }),
  );

  return (
    <div className="space-y-6">
      <nav className="text-xs text-white/50">
        <Link href="/explorer" className="hover:underline">Explorer</Link>
        <span className="px-1">/</span>
        <span>Contracts</span>
      </nav>

      <section className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.02] p-6 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-brand-accent/80">EticaHub registry</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">Contracts</h1>
          <p className="mt-2 max-w-2xl text-sm text-white/60">
            Known EticaHub and Etica ecosystem contracts with live code detection and verified-source status. The page stays public-RPC safe and avoids historical scans.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Link href="/explorer/verify" className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 hover:text-white">Verify contract →</Link>
          <Link href="/explorer/deploy" className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 hover:text-white">Create contract →</Link>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="grid grid-cols-[1fr_0.8fr_0.8fr] gap-3 border-b border-white/10 px-4 py-3 text-[11px] uppercase tracking-wider text-white/40 md:grid-cols-[1fr_0.8fr_1.2fr_0.8fr_0.8fr]">
          <div>Contract</div><div>Group</div><div className="hidden md:block">Address</div><div className="text-right">Code</div><div className="text-right">Source</div>
        </div>
        <div className="divide-y divide-white/5">
          {rows.map((row) => (
            <div key={row.address} className="grid grid-cols-[1fr_0.8fr_0.8fr] gap-3 px-4 py-3 text-sm md:grid-cols-[1fr_0.8fr_1.2fr_0.8fr_0.8fr] md:items-center">
              <div>
                <Link href={`/explorer/address/${row.address}`} className="font-medium text-white hover:text-brand-accent hover:underline">{addressLabel(row.address) ?? row.name}</Link>
                <div className="mt-1 text-xs text-white/45">{row.description}</div>
              </div>
              <div><span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/65">{row.group}</span></div>
              <div className="hidden md:block"><Link href={`/explorer/address/${row.address}`} className="font-mono text-xs text-white/65 hover:text-white hover:underline">{shortAddress(row.address, 8)}</Link></div>
              <div className="text-right"><span className={row.deployed ? 'text-emerald-300' : 'text-amber-300'}>{row.deployed ? 'deployed' : 'missing'}</span></div>
              <div className="text-right">
                {row.verified ? <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-300">verified</span> : <Link href={`/explorer/verify?address=${row.address}`} className="text-xs text-brand-accent hover:underline">verify</Link>}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
