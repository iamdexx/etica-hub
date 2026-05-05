'use client';

import { useState } from 'react';
import {
  BRIDGE_REMOTE_DEPLOYMENTS,
  isBridgeLive,
  isBridgeRemoteLive,
  type BridgeRemoteDomain,
} from '@etica-hub/shared';

type Flow = 'deposit' | 'claim' | 'burn';

const FLOWS: { id: Flow; label: string; subtitle: string }[] = [
  { id: 'deposit', label: 'Deposit', subtitle: 'Etica → Ethereum / BNB' },
  { id: 'claim', label: 'Claim', subtitle: 'matured wETX on remote chain' },
  { id: 'burn', label: 'Burn', subtitle: 'Ethereum / BNB → Etica' },
];

const REMOTE_DOMAINS: BridgeRemoteDomain[] = [1, 56];

export function BridgeFlowsCard() {
  const [flow, setFlow] = useState<Flow>('deposit');
  const [destination, setDestination] = useState<BridgeRemoteDomain>(1);
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');

  const live = isBridgeLive();
  const remoteLive = isBridgeRemoteLive(destination);
  const canSubmit = live && remoteLive && amount && recipient;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="flex flex-wrap gap-2">
        {FLOWS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFlow(f.id)}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${
              flow === f.id
                ? 'bg-brand-accent/20 text-brand-accent'
                : 'bg-white/5 text-white/60 hover:bg-white/10'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-1 text-xs text-white/40">{FLOWS.find((f) => f.id === flow)?.subtitle}</div>

      <div className="mt-4 space-y-3">
        {flow !== 'claim' ? (
          <>
            <Field label={flow === 'deposit' ? 'Destination chain' : 'Source chain'}>
              <select
                value={destination}
                onChange={(e) => setDestination(Number(e.target.value) as BridgeRemoteDomain)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-brand-accent/40"
              >
                {REMOTE_DOMAINS.map((d) => {
                  const r = BRIDGE_REMOTE_DEPLOYMENTS[d];
                  const remoteLiveOpt = isBridgeRemoteLive(d);
                  return (
                    <option key={d} value={d} className="bg-black">
                      {r.chainName}
                      {!remoteLiveOpt ? ' (not deployed)' : ''}
                    </option>
                  );
                })}
              </select>
            </Field>

            <Field label={flow === 'deposit' ? 'Amount (ETX)' : 'Amount (wETX)'}>
              <input
                inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 outline-none focus:border-brand-accent/40"
              />
            </Field>

            <Field
              label={
                flow === 'deposit'
                  ? `Recipient on ${BRIDGE_REMOTE_DEPLOYMENTS[destination].chainName}`
                  : 'Recipient on Etica'
              }
            >
              <input
                placeholder="0x…"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-mono text-white placeholder:text-white/30 outline-none focus:border-brand-accent/40"
              />
            </Field>
          </>
        ) : (
          <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-xs text-white/60">
            <div className="font-medium text-white/70">Auto-execute matured claims</div>
            <p className="mt-1">
              Pending claims auto-execute after a 48 h challenge window. The watcher bot pays the
              destination-chain gas so end users never have to. If a claim is stuck, anyone can call{' '}
              <code className="font-mono">executeClaim(nonce)</code> to release the funds.
            </p>
            <p className="mt-1 text-white/40">
              List of pending claims will appear here once the bridge is deployed.
            </p>
          </div>
        )}

        <button
          type="button"
          disabled={!canSubmit}
          className="w-full rounded-lg bg-brand-accent/20 px-4 py-2.5 text-sm font-medium text-brand-accent transition hover:bg-brand-accent/30 disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-white/30"
        >
          {!live
            ? 'Bridge launches with deploy'
            : !remoteLive
              ? `${BRIDGE_REMOTE_DEPLOYMENTS[destination].chainName} not deployed`
              : flow === 'deposit'
                ? 'Deposit ETX'
                : flow === 'claim'
                  ? 'Execute matured claim'
                  : 'Burn wETX'}
        </button>

        {!live ? (
          <div className="text-center text-xs text-white/40">
            Cross-chain wagmi config + signing flows unlock with the live deploy. See{' '}
            <code className="font-mono">docs/BRIDGE_DEPLOY_WALKTHROUGH.md</code>.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs text-white/40">{label}</div>
      {children}
    </div>
  );
}
