import {
  BRIDGE_ETICA_DEPLOYMENT,
  BRIDGE_REMOTE_DEPLOYMENTS,
  type BridgeRemoteDomain,
} from '@etica-hub/shared';
import type { Address } from 'viem';

const ZERO = '0x0000000000000000000000000000000000000000';

interface Row {
  label: string;
  address: Address;
  explorerUrl: string;
}

function rowsForEtica(): Row[] {
  return [
    { label: 'BridgeVault', address: BRIDGE_ETICA_DEPLOYMENT.bridgeVault as Address, explorerUrl: '/explorer/address' },
    { label: 'BridgeInsuranceFund', address: BRIDGE_ETICA_DEPLOYMENT.bridgeInsuranceFund as Address, explorerUrl: '/explorer/address' },
    { label: 'FeeRouter', address: BRIDGE_ETICA_DEPLOYMENT.feeRouter as Address, explorerUrl: '/explorer/address' },
    { label: 'InsuranceTopUpReceiver', address: BRIDGE_ETICA_DEPLOYMENT.insuranceTopUpReceiver as Address, explorerUrl: '/explorer/address' },
  ];
}

function rowsForRemote(domain: BridgeRemoteDomain): Row[] {
  const r = BRIDGE_REMOTE_DEPLOYMENTS[domain];
  const base = r.explorerUrl;
  return [
    { label: 'BridgeMinter', address: r.bridgeMinter as Address, explorerUrl: `${base}/address` },
    { label: 'WrappedETX (wETX)', address: r.wrappedEtx as Address, explorerUrl: `${base}/address` },
    { label: 'OptimisticVetoModule', address: r.optimisticVetoModule as Address, explorerUrl: `${base}/address` },
    { label: 'FraudProverModule', address: r.fraudProverModule as Address, explorerUrl: `${base}/address` },
    { label: 'HeartbeatISM', address: r.heartbeatIsm as Address, explorerUrl: `${base}/address` },
    { label: 'TVLCapISM', address: r.tvlCapIsm as Address, explorerUrl: `${base}/address` },
    { label: 'RateLimitISM', address: r.rateLimitIsm as Address, explorerUrl: `${base}/address` },
  ];
}

export function BridgeAddressBook() {
  const sections: { title: string; rows: Row[] }[] = [
    { title: 'Etica (61803)', rows: rowsForEtica() },
    { title: 'Ethereum (1)', rows: rowsForRemote(1) },
    { title: 'BNB Smart Chain (56)', rows: rowsForRemote(56) },
  ];

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="text-xs uppercase tracking-widest text-white/40">Address book</div>
      <div className="mt-3 space-y-4">
        {sections.map((s) => (
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
        Addresses populate from <code className="font-mono">packages/shared/src/addresses.ts</code> as
        each phase of <code className="font-mono">docs/BRIDGE_DEPLOY_WALKTHROUGH.md</code> lands. Rows
        showing <code className="font-mono">0x000…000</code> are not yet deployed on that chain.
      </p>
    </div>
  );
}

function AddressRow({ row }: { row: Row }) {
  const isZero = row.address === ZERO;
  const short = `${row.address.slice(0, 6)}…${row.address.slice(-4)}`;
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <span className="text-white/70">{row.label}</span>
      {isZero ? (
        <span className="font-mono text-xs text-white/30">not deployed</span>
      ) : (
        <a
          href={`${row.explorerUrl}/${row.address}`}
          target={row.explorerUrl.startsWith('/') ? undefined : '_blank'}
          rel="noopener noreferrer"
          className="font-mono text-xs text-brand-accent hover:underline"
        >
          {short}
        </a>
      )}
    </div>
  );
}
