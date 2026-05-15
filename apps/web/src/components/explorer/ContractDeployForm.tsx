'use client';

import { useMemo, useState } from 'react';
import { BaseError, isHex, parseEther, UserRejectedRequestError, type Hex } from 'viem';
import {
  useAccount,
  useChainId,
  useConnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { eticaMainnet } from '@etica-hub/shared/chains';

type DeployState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'pending'; hash: Hex }
  | { status: 'confirmed'; hash: Hex; contractAddress?: Hex }
  | { status: 'error'; error: string; hash?: Hex };

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

export function ContractDeployForm() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const [bytecode, setBytecode] = useState('');
  const [valueEgaz, setValueEgaz] = useState('');
  const [state, setState] = useState<DeployState>({ status: 'idle' });

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];
  const onMainnet = chainId === eticaMainnet.id;
  const trimmedBytecode = bytecode.trim();
  const canDeploy = useMemo(
    () =>
      isConnected &&
      onMainnet &&
      Boolean(walletClient) &&
      Boolean(publicClient) &&
      trimmedBytecode.length > 2 &&
      isHex(trimmedBytecode) &&
      state.status !== 'sending' &&
      state.status !== 'pending',
    [isConnected, onMainnet, publicClient, state.status, trimmedBytecode, walletClient],
  );

  async function deploy() {
    if (!walletClient || !publicClient) {
      setState({ status: 'error', error: 'Wallet or RPC client is not ready.' });
      return;
    }
    if (!isHex(trimmedBytecode)) {
      setState({ status: 'error', error: 'Creation bytecode must be 0x-prefixed hex.' });
      return;
    }

    let value = 0n;
    try {
      value = valueEgaz.trim() ? parseEther(valueEgaz.trim()) : 0n;
    } catch (err) {
      setState({ status: 'error', error: shortError(err) });
      return;
    }

    try {
      setState({ status: 'sending' });
      const hash = await walletClient.sendTransaction({
        chain: eticaMainnet,
        data: trimmedBytecode as Hex,
        value,
      });
      setState({ status: 'pending', hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      setState({
        status: receipt.status === 'success' ? 'confirmed' : 'error',
        hash,
        contractAddress: receipt.contractAddress ?? undefined,
        ...(receipt.status === 'success' ? {} : { error: 'Deployment transaction reverted.' }),
      } as DeployState);
    } catch (err) {
      setState({ status: 'error', error: shortError(err) });
    }
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Deploy contract</h2>
          <p className="mt-1 text-sm text-white/55">
            Paste compiled creation bytecode. Constructor args should already be ABI-encoded and appended.
          </p>
        </div>
        <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/60">
          Etica Mainnet · {eticaMainnet.id}
        </div>
      </div>

      <div className="space-y-4">
        <label className="block space-y-2">
          <div className="text-xs uppercase tracking-wider text-white/45">Creation bytecode</div>
          <textarea
            rows={16}
            value={bytecode}
            onChange={(event) => setBytecode(event.target.value)}
            placeholder="0x60806040..."
            className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-4 font-mono text-xs text-white placeholder-white/30 focus:border-brand-accent focus:outline-none"
          />
        </label>

        <label className="block max-w-sm space-y-2">
          <div className="text-xs uppercase tracking-wider text-white/45">Value to send (optional EGAZ)</div>
          <input
            value={valueEgaz}
            onChange={(event) => setValueEgaz(event.target.value)}
            placeholder="0"
            className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder-white/35 focus:border-brand-accent focus:outline-none"
          />
        </label>

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 p-4">
          <div className="max-w-2xl text-xs leading-5 text-white/50">
            This deployer uses your connected wallet and the normal Etica public RPC path. No private RPC,
            no server custody, and no Explorer backend signing. After deployment, verify the contract with
            Sourcify from the Verify Contract page.
          </div>

          {!isConnected ? (
            <button
              type="button"
              onClick={() => injectedConnector && connect({ connector: injectedConnector })}
              disabled={!injectedConnector || connectStatus === 'pending'}
              className="rounded-xl bg-brand-accent px-5 py-3 text-sm font-semibold text-brand-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {connectStatus === 'pending' ? 'Connecting...' : 'Connect wallet'}
            </button>
          ) : !onMainnet ? (
            <button
              type="button"
              onClick={() => switchChain({ chainId: eticaMainnet.id })}
              disabled={switching}
              className="rounded-xl bg-brand-accent px-5 py-3 text-sm font-semibold text-brand-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {switching ? 'Switching...' : 'Switch to Etica'}
            </button>
          ) : (
            <button
              type="button"
              onClick={deploy}
              disabled={!canDeploy}
              className="rounded-xl bg-brand-accent px-5 py-3 text-sm font-semibold text-brand-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {state.status === 'sending' ? 'Confirm in wallet...' : state.status === 'pending' ? 'Deploying...' : 'Deploy contract'}
            </button>
          )}
        </div>

        <DeployResult state={state} />
      </div>
    </section>
  );
}

function DeployResult({ state }: { state: DeployState }) {
  if (state.status === 'idle' || state.status === 'sending') return null;
  if (state.status === 'pending') {
    return (
      <div className="rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-200">
        Waiting for deployment confirmation...
        <div className="mt-2 break-all font-mono text-xs opacity-75">Tx: {state.hash}</div>
      </div>
    );
  }
  if (state.status === 'confirmed') {
    return (
      <div className="rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-4 text-sm text-emerald-200">
        Contract deployed successfully.
        <div className="mt-2 space-y-1 break-all font-mono text-xs opacity-80">
          <div>Tx: {state.hash}</div>
          {state.contractAddress ? <div>Contract: {state.contractAddress}</div> : null}
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          {state.contractAddress ? (
            <a href={`/explorer/address/${state.contractAddress}`} className="underline underline-offset-4">
              Open contract →
            </a>
          ) : null}
          {state.contractAddress ? (
            <a href={`/explorer/verify?address=${state.contractAddress}`} className="underline underline-offset-4">
              Verify contract →
            </a>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-rose-400/25 bg-rose-400/10 p-4 text-sm text-rose-200">
      {state.error}
      {state.hash ? <div className="mt-2 break-all font-mono text-xs opacity-75">Tx: {state.hash}</div> : null}
    </div>
  );
}
