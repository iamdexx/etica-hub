'use client';

import { useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';
import {
  useAccount,
  useChainId,
  useConnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { eticaMainnet } from '@etica-hub/shared/chains';
import {
  classifyAbi,
  parseArg,
  stringifyResult,
} from '@/lib/abi-forms';

type Tab = 'read' | 'write';

type CallState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; result: string }
  | { status: 'pending'; hash: Hex }
  | { status: 'confirmed'; hash: Hex }
  | { status: 'error'; error: string; hash?: Hex };

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

/**
 * Client-side Contract interaction panel for the explorer's verified
 * contract pages. Renders a Read / Write tab pair and, inside each tab,
 * one collapsible card per ABI function.
 *
 * Reads go through the explorer's own `usePublicClient()` — no wallet
 * required. Writes require a connected wallet on Etica Mainnet; a
 * "Connect" or "Switch network" button surfaces inline on each write
 * card when preconditions aren't met.
 *
 * Rendering is intentionally minimal: the explorer is a read-first tool,
 * and this is the only component on the address page that needs client
 * JS. Everything else stays server-rendered.
 */
export function ContractInteractionView({
  address,
  abi,
}: {
  address: Address;
  abi: Abi;
}) {
  const [tab, setTab] = useState<Tab>('read');
  const { reads, writes } = useMemo(() => classifyAbi(abi), [abi]);

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Contract</h2>
        <div className="flex rounded-lg border border-white/10 bg-black/30 p-0.5 text-xs">
          <button
            onClick={() => setTab('read')}
            className={`rounded-md px-3 py-1 ${
              tab === 'read'
                ? 'bg-white/10 text-white'
                : 'text-white/60 hover:text-white'
            }`}
          >
            Read ({reads.length})
          </button>
          <button
            onClick={() => setTab('write')}
            className={`rounded-md px-3 py-1 ${
              tab === 'write'
                ? 'bg-white/10 text-white'
                : 'text-white/60 hover:text-white'
            }`}
          >
            Write ({writes.length})
          </button>
        </div>
      </div>

      {tab === 'read' ? (
        reads.length === 0 ? (
          <EmptyState kind="read" />
        ) : (
          <ul className="space-y-2">
            {reads.map((fn, i) => (
              <li key={`${fn.name}:${i}`}>
                <ReadCard address={address} abi={abi} fn={fn} />
              </li>
            ))}
          </ul>
        )
      ) : writes.length === 0 ? (
        <EmptyState kind="write" />
      ) : (
        <ul className="space-y-2">
          {writes.map((fn, i) => (
            <li key={`${fn.name}:${i}`}>
              <WriteCard address={address} abi={abi} fn={fn} />
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-[10px] text-white/35">
        Calls go directly to the configured RPC ({eticaMainnet.name}). Writes
        require a connected wallet on Etica Mainnet (chain ID{' '}
        {eticaMainnet.id}).
      </p>
    </section>
  );
}

function EmptyState({ kind }: { kind: Tab }) {
  return (
    <p className="text-sm text-white/50">
      No {kind === 'read' ? 'view / pure' : 'state-changing'} functions declared
      in this contract&apos;s ABI.
    </p>
  );
}

function ReadCard({
  address,
  abi,
  fn,
}: {
  address: Address;
  abi: Abi;
  fn: AbiFunction;
}) {
  const publicClient = usePublicClient();
  const [inputs, setInputs] = useState<string[]>(() =>
    (fn.inputs ?? []).map(() => ''),
  );
  const [state, setState] = useState<CallState>({ status: 'idle' });

  async function run() {
    if (!publicClient) {
      setState({ status: 'error', error: 'RPC client not ready' });
      return;
    }
    setState({ status: 'running' });
    let args: unknown[];
    try {
      args = (fn.inputs ?? []).map((inp, i) =>
        parseArg(
          inp.type,
          inputs[i] ?? '',
          (inp as unknown as { components?: ReadonlyArray<{ type: string }> })
            .components,
        ),
      );
    } catch (err) {
      setState({ status: 'error', error: shortError(err) });
      return;
    }
    try {
      const result = await publicClient.readContract({
        address,
        abi,
        functionName: fn.name,
        args,
      });
      setState({ status: 'ok', result: stringifyResult(result) });
    } catch (err) {
      setState({ status: 'error', error: shortError(err) });
    }
  }

  return (
    <details className="rounded-lg border border-white/5 bg-black/30">
      <summary className="cursor-pointer px-3 py-2 font-mono text-[11px] text-white/80 hover:text-white">
        {fn.name}
        {signatureHint(fn)}
      </summary>
      <div className="space-y-2 border-t border-white/5 px-3 py-3">
        <Inputs fn={fn} values={inputs} onChange={setInputs} />
        <div className="flex items-center gap-2">
          <button
            onClick={run}
            disabled={state.status === 'running'}
            className="rounded-md bg-emerald-500/80 px-3 py-1.5 text-xs font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
          >
            {state.status === 'running' ? 'Querying…' : 'Query'}
          </button>
          <span className="text-[10px] text-white/40">
            {fn.outputs && fn.outputs.length > 0
              ? `→ ${fn.outputs.map((o) => o.type).join(', ')}`
              : '→ ()'}
          </span>
        </div>
        <ResultBox state={state} />
      </div>
    </details>
  );
}

function WriteCard({
  address,
  abi,
  fn,
}: {
  address: Address;
  abi: Abi;
  fn: AbiFunction;
}) {
  const { address: account, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const isPayable = fn.stateMutability === 'payable';

  const [inputs, setInputs] = useState<string[]>(() =>
    (fn.inputs ?? []).map(() => ''),
  );
  const [valueEgaz, setValueEgaz] = useState<string>('');
  const [state, setState] = useState<CallState>({ status: 'idle' });

  const injectedConnector =
    connectors.find((c) => c.id === 'injected') ?? connectors[0];

  async function run() {
    if (!walletClient || !publicClient || !account) {
      setState({ status: 'error', error: 'Wallet not ready' });
      return;
    }
    let args: unknown[];
    try {
      args = (fn.inputs ?? []).map((inp, i) =>
        parseArg(
          inp.type,
          inputs[i] ?? '',
          (inp as unknown as { components?: ReadonlyArray<{ type: string }> })
            .components,
        ),
      );
    } catch (err) {
      setState({ status: 'error', error: shortError(err) });
      return;
    }
    let value: bigint | undefined;
    if (isPayable && valueEgaz.trim()) {
      try {
        value = parseEgazToWei(valueEgaz.trim());
      } catch (err) {
        setState({ status: 'error', error: shortError(err) });
        return;
      }
    }
    setState({ status: 'running' });
    // Declared outside the try so that a receipt-polling failure after
    // a successful `writeContract` still surfaces the tx hash in the
    // error state — otherwise the user loses their link to a submitted
    // transaction if the RPC hiccups during confirmation.
    let hash: Hex | undefined;
    try {
      hash = await walletClient.writeContract({
        address,
        abi,
        functionName: fn.name,
        args,
        ...(value != null ? { value } : {}),
      });
      setState({ status: 'pending', hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setState({ status: 'error', hash, error: 'Reverted on-chain' });
      } else {
        setState({ status: 'confirmed', hash });
      }
    } catch (err) {
      setState({
        status: 'error',
        error: shortError(err),
        ...(hash ? { hash } : {}),
      });
    }
  }

  const badgeClass = isPayable
    ? 'rounded-full bg-amber-400/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-amber-300'
    : 'rounded-full bg-white/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-white/60';

  return (
    <details className="rounded-lg border border-white/5 bg-black/30">
      <summary className="cursor-pointer px-3 py-2 font-mono text-[11px] text-white/80 hover:text-white">
        <span className="mr-2 inline-flex">
          <span className={badgeClass}>
            {isPayable ? 'payable' : 'write'}
          </span>
        </span>
        {fn.name}
        {signatureHint(fn)}
      </summary>
      <div className="space-y-2 border-t border-white/5 px-3 py-3">
        <Inputs fn={fn} values={inputs} onChange={setInputs} />
        {isPayable ? (
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-white/50">
              msg.value (EGAZ)
            </label>
            <input
              value={valueEgaz}
              onChange={(e) => setValueEgaz(e.target.value)}
              placeholder="0.0"
              className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 font-mono text-xs text-white placeholder:text-white/30 focus:border-emerald-400/40 focus:outline-none"
            />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {!isConnected ? (
            <button
              onClick={() =>
                injectedConnector && connect({ connector: injectedConnector })
              }
              disabled={!injectedConnector || connectStatus === 'pending'}
              className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400 disabled:opacity-50"
            >
              {connectStatus === 'pending' ? 'Connecting…' : 'Connect wallet'}
            </button>
          ) : !onMainnet ? (
            <button
              onClick={() => switchChain({ chainId: eticaMainnet.id })}
              disabled={switching}
              className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400 disabled:opacity-50"
            >
              {switching
                ? 'Switching…'
                : `Switch to ${eticaMainnet.name}`}
            </button>
          ) : (
            <button
              onClick={run}
              disabled={state.status === 'running' || !walletClient}
              className="rounded-md bg-emerald-500/80 px-3 py-1.5 text-xs font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
            >
              {state.status === 'running' ? 'Signing…' : 'Write'}
            </button>
          )}
          <span className="text-[10px] text-white/40">
            {fn.outputs && fn.outputs.length > 0
              ? `→ ${fn.outputs.map((o) => o.type).join(', ')}`
              : '→ ()'}
          </span>
        </div>
        <ResultBox state={state} />
      </div>
    </details>
  );
}

function Inputs({
  fn,
  values,
  onChange,
}: {
  fn: AbiFunction;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  if (!fn.inputs || fn.inputs.length === 0) {
    return <p className="text-[10px] text-white/40">No arguments.</p>;
  }
  return (
    <div className="space-y-2">
      {fn.inputs.map((inp, i) => (
        <div key={`${inp.name ?? ''}:${i}`}>
          <label className="mb-1 block text-[10px] uppercase tracking-wider text-white/50">
            {inp.name || `arg${i}`}{' '}
            <span className="text-white/35">({inp.type})</span>
          </label>
          <input
            value={values[i] ?? ''}
            onChange={(e) => {
              const next = [...values];
              next[i] = e.target.value;
              onChange(next);
            }}
            placeholder={placeholderFor(inp.type)}
            className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 font-mono text-xs text-white placeholder:text-white/30 focus:border-emerald-400/40 focus:outline-none"
          />
        </div>
      ))}
    </div>
  );
}

function ResultBox({ state }: { state: CallState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'running') {
    return <p className="text-[11px] text-white/50">Running…</p>;
  }
  if (state.status === 'ok') {
    return (
      <pre className="max-h-64 overflow-auto rounded-md border border-emerald-300/20 bg-emerald-300/[0.03] px-3 py-2 font-mono text-[11px] text-emerald-200">
        {state.result || '(no return value)'}
      </pre>
    );
  }
  if (state.status === 'pending') {
    return (
      <p className="text-[11px] text-white/60">
        Pending: <TxLink hash={state.hash} />
      </p>
    );
  }
  if (state.status === 'confirmed') {
    return (
      <p className="text-[11px] text-emerald-300">
        Confirmed: <TxLink hash={state.hash} />
      </p>
    );
  }
  return (
    <p className="rounded-md border border-rose-400/30 bg-rose-400/[0.06] px-3 py-2 text-[11px] text-rose-300">
      {state.error}
      {state.hash ? (
        <>
          {' · '}
          <TxLink hash={state.hash} />
        </>
      ) : null}
    </p>
  );
}

function TxLink({ hash }: { hash: Hex }) {
  return (
    <a
      href={`/explorer/tx/${hash}`}
      className="font-mono text-emerald-400 hover:underline"
    >
      {hash.slice(0, 10)}…{hash.slice(-6)}
    </a>
  );
}

function signatureHint(fn: AbiFunction): string {
  const inputs = (fn.inputs ?? []).map((i) => i.type).join(', ');
  return `(${inputs})`;
}

function placeholderFor(type: string): string {
  if (type === 'address') return '0x…';
  if (type === 'bool') return 'true';
  if (type === 'string') return 'hello';
  if (type.startsWith('uint') || type.startsWith('int')) return '0';
  if (type === 'bytes') return '0x…';
  if (type.startsWith('bytes')) return '0x…';
  if (type.endsWith('[]')) return '[…]';
  return '';
}

/**
 * Parses a human-entered EGAZ string (e.g. `"1.5"` or `"0.000000001"`)
 * into wei (1e18 base units). Rejects negative amounts and garbage
 * input with a readable error.
 */
function parseEgazToWei(raw: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error('msg.value must be a non-negative decimal');
  }
  const [intPart, fracPart = ''] = raw.split('.');
  if (fracPart.length > 18) {
    throw new Error('msg.value has too many fractional digits (max 18)');
  }
  const padded = (fracPart + '0'.repeat(18 - fracPart.length)).slice(0, 18);
  return BigInt(intPart) * 10n ** 18n + BigInt(padded || '0');
}
