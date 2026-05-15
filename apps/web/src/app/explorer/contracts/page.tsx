import Link from 'next/link';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES } from '@etica-hub/shared';
import { addressLabel, explorerClient, shortAddress } from '@/lib/explorer';

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
    d?.etx && d.etx !== ZERO ? { address: d.etx, name: 'ETX Token', group: 'Token', description: 'EticaHub routing and rewards asset' } : null,
    d?.wegaz && d.wegaz !== ZERO ? { address: d.wegaz, name: 'Wrapped EGAZ', group: 'Token', description: 'Wrapped native gas asset' } : null,
    ext?.eti && ext.eti !== ZERO ? { address: ext.eti, name: 'ETI Token', group: 'Token', description: 'Etica ecosystem token' } : null,
    d?.swapFactory && d.swapFactory !== ZERO ? { address: d.swapFactory, name: 'EticaSwap Factory', group: 'DEX', description: 'Liquidity pair factory' } : null,
    d?.swapRouter && d.swapRouter !== ZERO ? { address: d.swapRouter, name: 'EticaSwap Router', group: 'DEX', description: 'Swap routing contract' } : null,
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

      <section className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-6 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-brand-accent/80">EticaHub registry</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Contracts</h1>
          <p className="mt-2 max-w-2xl text-sm text-white/60">
            Known EticaHub ecosystem contracts with live deployment detection. Public-RPC safe and Explorer-native.
          </p>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="grid grid-cols-[1fr_0.8fr_0.8fr] gap-3 border-b border-white/10 px-4 py-3 text-[11px] uppercase tracking-wider text-white/40 md:grid-cols-[1fr_0.8fr_1fr_0.7fr]">
          <div>Contract</div>
          <div>Group</div>
          <div className="hidden md:block">Address</div>
          <div className="text-right">Status</div>
        </div>
        <div className="divide-y divide-white/5">
          {rows.map((row) => (
            <div key={row.address} className="grid grid-cols-[1fr_0.8fr_0.8fr] gap-3 px-4 py-3 text-sm md:grid-cols-[1fr_0.8fr_1fr_0.7fr] md:items-center">
              <div>
                <Link href={`/explorer/address/${row.address}`} className="font-medium text-white hover:text-brand-accent hover:underline">
                  {addressLabel(row.address) ?? row.name}
                </Link>
                <div className="mt-1 text-xs text-white/45">{row.description}</div>
              </div>
              <div>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/65">
                  {row.group}
                </span>
              </div>
              <div className="hidden md:block">
                <Link href={`/explorer/address/${row.address}`} className="font-mono text-xs text-white/65 hover:text-white hover:underline">
                  {shortAddress(row.address, 8)}
                </Link>
              </div>
              <div className="text-right">
                <span className={row.deployed ? 'text-emerald-300' : 'text-amber-300'}>
                  {row.deployed ? 'deployed' : 'missing'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
