import { BRIDGE_ROLES, USDC_WARP_ROUTE } from '@etica-hub/shared';
import type { Address } from 'viem';

interface Row {
  label: string;
  address: Address;
  href: string;
  note?: string;
}

const ETHERSCAN = 'https://etherscan.io/address';
const ETICA = '/explorer/address';

const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: 'Ethereum (1)',
    rows: [
      { label: 'USDC (Circle)', address: USDC_WARP_ROUTE.collateralToken, href: ETHERSCAN },
      {
        label: 'Collateral router',
        address: USDC_WARP_ROUTE.collateralRouter,
        href: ETHERSCAN,
        note: 'HypERC20Collateral — holds every locked USDC',
      },
      {
        label: 'Fee contract',
        address: USDC_WARP_ROUTE.collateralFee,
        href: ETHERSCAN,
        note: 'LinearFee, 0.5% ≤ 50 USDC',
      },
    ],
  },
  {
    title: 'Etica (61803)',
    rows: [
      {
        label: 'USDC.e token / router',
        address: USDC_WARP_ROUTE.syntheticToken,
        href: ETICA,
        note: 'HypERC20 — minted 1:1 against locked USDC',
      },
      {
        label: 'Fee contract',
        address: USDC_WARP_ROUTE.syntheticFee,
        href: ETICA,
        note: 'WarpFlatLinearFee, 2 USDC.e + 0.5% ≤ 50',
      },
    ],
  },
  {
    title: 'Roles',
    rows: [
      { label: 'Owner (treasury)', address: BRIDGE_ROLES.owner, href: ETICA, note: 'Admin only, earns no fees' },
      { label: 'Keeper', address: BRIDGE_ROLES.keeper, href: ETICA, note: 'Owns both fee contracts' },
      { label: 'Validator', address: BRIDGE_ROLES.validator, href: ETICA, note: 'Signs checkpoints, 1-of-1 at launch' },
      { label: 'Relayer', address: BRIDGE_ROLES.relayer, href: ETICA, note: 'Pays delivery gas on both chains' },
      { label: 'Guardian', address: BRIDGE_ROLES.guardian, href: ETICA, note: 'Can pause inbound delivery only' },
    ],
  },
];

export function UsdcRouteAddressBook() {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="text-xs uppercase tracking-widest text-white/40">Address book</div>
      <div className="mt-3 space-y-4">
        {SECTIONS.map((s) => (
          <div key={s.title}>
            <div className="text-sm font-medium text-white/80">{s.title}</div>
            <div className="mt-1.5 divide-y divide-white/5 rounded-lg border border-white/5 bg-white/[0.02]">
              {s.rows.map((row) => (
                <AddressRow key={row.label} row={row} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-white/40">
        Source of truth: <code className="font-mono">packages/shared/src/addresses.ts</code> and the Hyperlane
        registry under <code className="font-mono">infra/hyperlane/registry</code>. Role keys are hot keys;
        the owner can hand control to a Safe with one <code className="font-mono">transferOwnership</code> per contract.
      </p>
    </div>
  );
}

function AddressRow({ row }: { row: Row }) {
  const short = `${row.address.slice(0, 6)}…${row.address.slice(-4)}`;
  const external = !row.href.startsWith('/');
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="text-white/70">{row.label}</div>
        {row.note ? <div className="text-[11px] text-white/35">{row.note}</div> : null}
      </div>
      <a
        href={`${row.href}/${row.address}`}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        className="shrink-0 font-mono text-xs text-brand-accent hover:underline"
        title={row.address}
      >
        {short}
      </a>
    </div>
  );
}
