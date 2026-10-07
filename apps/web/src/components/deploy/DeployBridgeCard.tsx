'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BaseError, UserRejectedRequestError, isAddress, toHex, type Address } from 'viem';
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useSignTypedData,
  useSwitchChain,
} from 'wagmi';
import { BRIDGE_ROLES } from '@etica-hub/shared';
import { eticaMainnet } from '@etica-hub/shared/chains';
import {
  BRIDGE_DEPLOY_DOMAIN,
  BRIDGE_DEPLOY_PRIMARY_TYPE,
  BRIDGE_DEPLOY_STEPS,
  BRIDGE_DEPLOY_TYPES,
  DEPLOY_CONFIRM_PHRASE,
  toDeployMessageJson,
  type BridgeDeployMessage,
  type BridgeDeployStep,
} from '@/lib/bridge-deploy/typed-data';
import type { BridgeDeployPreflight } from '@/lib/bridge-deploy/server';
import type { DeployRunWithAddresses } from '@/app/api/bridge/deploy/status/route';

const STEP_HELP: Record<BridgeDeployStep, string> = {
  all: 'Core on Etica, then both routers + fee contracts, then the agent config. First deploy.',
  core: 'Hyperlane Mailbox, ISM and hooks on Etica only (~2.5 EGAZ).',
  warp: 'Routers + fee contracts on Ethereum and Etica; needs core already on main.',
  'agent-config': 'Re-render infra/hyperlane/agents/agent-config.json only. No gas.',
};

type Submit =
  | { status: 'idle' }
  | { status: 'signing' }
  | { status: 'sending' }
  | { status: 'done'; mode: 'deploy' | 'preflight' }
  | { status: 'error'; error: string };

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

function sameAddress(a?: string, b?: string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function AddressInput({
  label,
  value,
  onChange,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  help: string;
}) {
  const valid = isAddress(value.trim());
  return (
    <label className="block space-y-1 text-sm">
      <span className="text-white/80">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className={`w-full rounded-lg border bg-black/30 px-3 py-2 font-mono text-xs text-white/90 outline-none ${
          valid ? 'border-white/15' : 'border-rose-500/60'
        }`}
      />
      <span className="block text-xs text-white/45">{help}</span>
    </label>
  );
}

function RunRow({ run }: { run: DeployRunWithAddresses }) {
  const tone =
    run.conclusion === 'success'
      ? 'text-emerald-300'
      : run.status !== 'completed'
        ? 'text-amber-300'
        : 'text-rose-300';
  const a = run.addresses;
  const core = a?.core ?? {};
  return (
    <li className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a href={run.htmlUrl} target="_blank" rel="noreferrer" className="font-medium text-white/85 underline">
          Run #{run.runNumber}
        </a>
        <span className={tone}>{run.status === 'completed' ? (run.conclusion ?? 'unknown') : (run.status ?? 'queued')}</span>
        <span className="text-white/40">{new Date(run.createdAt).toLocaleString()}</span>
      </div>
      {a && (
        <dl className="mt-2 grid gap-1 font-mono text-[11px] text-white/75">
          {core.mailbox && <Row k="Etica mailbox" v={core.mailbox} />}
          {core.validatorAnnounce && <Row k="Etica validatorAnnounce" v={core.validatorAnnounce} />}
          {core.merkleTreeHook && <Row k="Etica merkleTreeHook" v={core.merkleTreeHook} />}
          {a.ethereumRouter && <Row k="Ethereum USDC collateral router" v={a.ethereumRouter} />}
          {a.eticaRouter && <Row k="Etica USDC.e router / token" v={a.eticaRouter} />}
          {a.eticaFeeContract && <Row k="Etica fee contract" v={a.eticaFeeContract} />}
          <div className="text-white/40">
            branch <span className="text-white/60">{a.branch}</span>
          </div>
        </dl>
      )}
      {run.conclusion === 'success' && !a && (
        <div className="mt-2 text-white/50">Pre-flight only (no addresses rendered).</div>
      )}
    </li>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3">
      <dt className="text-white/50">{k}</dt>
      <dd className="break-all">{v}</dd>
    </div>
  );
}

export function DeployBridgeCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();

  const onMainnet = chainId === eticaMainnet.id;
  const isKeeper = sameAddress(address, BRIDGE_ROLES.keeper);

  const [preflight, setPreflight] = useState<BridgeDeployPreflight | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [runs, setRuns] = useState<DeployRunWithAddresses[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);

  const [step, setStep] = useState<BridgeDeployStep>('all');
  const [owner, setOwner] = useState<string>(BRIDGE_ROLES.owner);
  const [validator, setValidator] = useState<string>(BRIDGE_ROLES.validator);
  const [guardian, setGuardian] = useState<string>(BRIDGE_ROLES.guardian);
  const [confirmInput, setConfirmInput] = useState('');
  const [submit, setSubmit] = useState<Submit>({ status: 'idle' });

  const loadPreflight = useCallback(async () => {
    setPreflightError(null);
    try {
      const res = await fetch('/api/bridge/deploy/preflight', { cache: 'no-store' });
      const body = (await res.json()) as BridgeDeployPreflight | { error: string };
      if (!res.ok || 'error' in body) throw new Error('error' in body ? body.error : `HTTP ${res.status}`);
      setPreflight(body);
    } catch (err) {
      setPreflightError(shortError(err));
    }
  }, []);

  const loadRuns = useCallback(async () => {
    setRunsError(null);
    try {
      const res = await fetch('/api/bridge/deploy/status', { cache: 'no-store' });
      const body = (await res.json()) as { runs: DeployRunWithAddresses[] } | { error: string };
      if (!res.ok || 'error' in body) throw new Error('error' in body ? body.error : `HTTP ${res.status}`);
      setRuns(body.runs);
    } catch (err) {
      setRunsError(shortError(err));
    }
  }, []);

  useEffect(() => {
    void loadPreflight();
    void loadRuns();
    const t = setInterval(() => void loadRuns(), 15_000);
    return () => clearInterval(t);
  }, [loadPreflight, loadRuns]);

  const rolesValid = useMemo(() => {
    const o = owner.trim();
    const v = validator.trim();
    const g = guardian.trim();
    if (![o, v, g].every((x) => isAddress(x))) return 'Every role must be a valid address.';
    if ([o, v, g].some((x) => sameAddress(x, BRIDGE_ROLES.keeper))) return 'The keeper cannot also be owner, validator or guardian.';
    if (sameAddress(o, v)) return 'Owner and validator must differ.';
    return null;
  }, [owner, validator, guardian]);

  const confirmTyped = confirmInput.trim() === DEPLOY_CONFIRM_PHRASE;
  const needsGas = step !== 'agent-config';
  const canSign = isConnected && isKeeper && onMainnet && !rolesValid && submit.status !== 'signing' && submit.status !== 'sending';

  async function authorize(confirm: '' | typeof DEPLOY_CONFIRM_PHRASE) {
    if (!canSign || !address) return;
    const message: BridgeDeployMessage = {
      step,
      owner: owner.trim() as Address,
      validator: validator.trim() as Address,
      guardian: guardian.trim() as Address,
      confirm,
      nonce: randomNonce(),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    };
    setSubmit({ status: 'signing' });
    let signature: `0x${string}`;
    try {
      signature = await signTypedDataAsync({
        account: address,
        domain: BRIDGE_DEPLOY_DOMAIN,
        types: BRIDGE_DEPLOY_TYPES,
        primaryType: BRIDGE_DEPLOY_PRIMARY_TYPE,
        message,
      });
    } catch (err) {
      setSubmit({ status: 'error', error: shortError(err) });
      return;
    }
    setSubmit({ status: 'sending' });
    try {
      const res = await fetch('/api/bridge/deploy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: toDeployMessageJson(message), signature }),
      });
      const body = (await res.json()) as { ok: boolean; mode?: 'deploy' | 'preflight'; error?: string; detail?: string };
      if (!res.ok || !body.ok) {
        throw new Error([body.error, body.detail].filter(Boolean).join(' — ') || `HTTP ${res.status}`);
      }
      setSubmit({ status: 'done', mode: body.mode ?? (confirm ? 'deploy' : 'preflight') });
      setConfirmInput('');
      setTimeout(() => void loadRuns(), 4_000);
    } catch (err) {
      setSubmit({ status: 'error', error: shortError(err) });
    }
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">How this works</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-white/70">
          <li>
            Connect the keeper wallet <span className="font-mono">{BRIDGE_ROLES.keeper}</span>. Only
            its signature is accepted.
          </li>
          <li>Check the pre-flight below (balances, gas price, roles, workflow access).</li>
          <li>
            Sign <em>Pre-flight only</em> first: the workflow runs its own checks and stops. Then type{' '}
            <span className="font-mono">{DEPLOY_CONFIRM_PHRASE}</span> and sign <em>Deploy</em>.
          </li>
          <li>
            The run appears in <em>Deploy runs</em>; when it succeeds the rendered addresses show up
            there (also pushed to a <span className="font-mono">bridge-deploy/&lt;run&gt;</span>{' '}
            branch) and get wired into the app + agents in a follow-up PR.
          </li>
        </ol>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Keeper wallet</h2>
        {!isConnected && (
          <button
            onClick={() => injectedConnector && connect({ connector: injectedConnector })}
            disabled={!injectedConnector || connectStatus === 'pending'}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
          >
            {connectStatus === 'pending' ? 'Connecting…' : 'Connect wallet'}
          </button>
        )}
        {isConnected && (
          <div className="space-y-3 text-sm">
            <div className="font-mono break-all text-white/80">{address}</div>
            {!isKeeper && (
              <div className="text-rose-300">
                This is not the keeper. Switch the wallet to{' '}
                <span className="font-mono">{BRIDGE_ROLES.keeper}</span>.
              </div>
            )}
            <div>
              Chain:{' '}
              <span className={onMainnet ? 'text-emerald-400' : 'text-amber-400'}>
                {onMainnet ? 'Etica Mainnet (61803)' : `Wrong network (${chainId})`}
              </span>
            </div>
            {!onMainnet && (
              <button
                onClick={() => switchChain({ chainId: eticaMainnet.id })}
                disabled={switching}
                className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400 disabled:opacity-50"
              >
                {switching ? 'Switching…' : 'Switch to Etica Mainnet'}
              </button>
            )}
            <button
              onClick={() => disconnect()}
              className="ml-2 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-medium text-white/70 hover:bg-white/10"
            >
              Disconnect
            </button>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Pre-flight</h2>
          <button
            onClick={() => void loadPreflight()}
            className="rounded-lg border border-white/20 px-3 py-1 text-xs text-white/70 hover:bg-white/10"
          >
            Refresh
          </button>
        </div>
        {preflightError && <div className="text-sm text-rose-300">{preflightError}</div>}
        {!preflight && !preflightError && <div className="text-sm text-white/50">Reading balances…</div>}
        {preflight && (
          <ul className="space-y-1 text-sm">
            {preflight.checks.map((c) => (
              <li key={c.label} className="flex gap-2">
                <span className={c.ok ? 'text-emerald-400' : 'text-rose-400'}>{c.ok ? '●' : '○'}</span>
                <span className="text-white/80">{c.label}</span>
                <span className="ml-auto text-right font-mono text-xs text-white/50">{c.detail}</span>
              </li>
            ))}
            <li className="pt-2 text-xs text-white/45">
              Core already on main: {preflight.coreDeployed ? 'yes (use step warp)' : 'no (use step all)'} ·
              checked {new Date(preflight.generatedAt).toLocaleTimeString()}
            </li>
          </ul>
        )}
      </section>

      <section className="space-y-4 rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="text-lg font-semibold">Deploy parameters</h2>
        <label className="block space-y-1 text-sm">
          <span className="text-white/80">Step</span>
          <select
            value={step}
            onChange={(e) => setStep(e.target.value as BridgeDeployStep)}
            className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white/90"
          >
            {BRIDGE_DEPLOY_STEPS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span className="block text-xs text-white/45">{STEP_HELP[step]}</span>
        </label>
        <AddressInput
          label="Owner"
          value={owner}
          onChange={setOwner}
          help="Owns mailbox, ISMs, routers and the 5k/day rate limit. Treasury at launch; transferable later. Earns nothing."
        />
        <AddressInput
          label="Validator"
          value={validator}
          onChange={setValidator}
          help="Address of the validator key generated on the agent droplet (/root/eticahub-keys/validator.env)."
        />
        <AddressInput
          label="Guardian"
          value={guardian}
          onChange={setGuardian}
          help="Owns the PausableIsm on each router: can pause inbound delivery and nothing else."
        />
        {rolesValid && <div className="text-sm text-rose-300">{rolesValid}</div>}
        <div className="text-xs text-white/45">
          Fees (50 bps, 50 USDC cap, flat 2 USDC.e on Etica) go to the keeper{' '}
          <span className="font-mono">{BRIDGE_ROLES.keeper}</span>, which is also the deployer and relayer.
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="text-lg font-semibold">Authorise</h2>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => void authorize('')}
            disabled={!canSign}
            className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-400/20 disabled:opacity-40"
          >
            Sign: pre-flight only
          </button>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <input
              type="text"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={`type ${DEPLOY_CONFIRM_PHRASE}`}
              spellCheck={false}
              className="min-w-[14rem] flex-1 rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs text-white/90 outline-none"
            />
            <button
              onClick={() => void authorize(DEPLOY_CONFIRM_PHRASE)}
              disabled={!canSign || !confirmTyped || (needsGas && !preflight?.ready)}
              className="rounded-lg bg-rose-500 px-4 py-2 text-sm font-medium text-black hover:bg-rose-400 disabled:opacity-40"
            >
              Sign: deploy to mainnet
            </button>
          </div>
        </div>
        {needsGas && preflight && !preflight.ready && (
          <div className="text-xs text-amber-300/80">Deploy is disabled until every pre-flight check passes.</div>
        )}
        {submit.status === 'signing' && <div className="text-sm text-white/70">Waiting for the wallet signature…</div>}
        {submit.status === 'sending' && <div className="text-sm text-white/70">Dispatching the workflow…</div>}
        {submit.status === 'done' && (
          <div className="text-sm text-emerald-300">
            {submit.mode === 'deploy' ? 'Mainnet deploy dispatched.' : 'Pre-flight run dispatched.'} Watch it under
            Deploy runs below.
          </div>
        )}
        {submit.status === 'error' && <div className="text-sm text-rose-300">{submit.error}</div>}
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Deploy runs</h2>
          <button
            onClick={() => void loadRuns()}
            className="rounded-lg border border-white/20 px-3 py-1 text-xs text-white/70 hover:bg-white/10"
          >
            Refresh
          </button>
        </div>
        {runsError && <div className="text-sm text-rose-300">{runsError}</div>}
        {runs && runs.length === 0 && <div className="text-sm text-white/50">No runs yet.</div>}
        {runs && runs.length > 0 && (
          <ul className="space-y-2">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
