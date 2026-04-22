'use client';

import { useState } from 'react';
import { BaseError, UserRejectedRequestError, type Address, type Hex } from 'viem';
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { eticaMainnet } from '@etica-hub/shared/chains';
import storageArtifact from '@/lib/sourcify-storage-artifact.json';

/**
 * One-shot deployer for the Storage contract Sourcify uses as their
 * per-chain verification fixture. This is purely a Sourcify enablement
 * step — the deployed contract has no role in EticaHub itself.
 *
 * The bytecode is precompiled from the exact standard-JSON input that
 * Sourcify's CI feeds through solc 0.8.7+commit.e28d00a7 (optimizer=off,
 * evmVersion=london, metadata.bytecodeHash=ipfs). Compiling from
 * somewhere else and getting a different metadata hash would make
 * Sourcify's test_chains run fail even on a correctly-executing
 * contract, so we pin to a single artifact here.
 */

type DeployState = {
  status: 'idle' | 'signing' | 'pending' | 'confirmed' | 'error';
  txHash?: Hex;
  address?: Address;
  error?: string;
};

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

export function DeployStorageFixtureCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const [state, setState] = useState<DeployState>({ status: 'idle' });

  async function onDeploy() {
    if (!walletClient || !publicClient || !address) return;
    setState({ status: 'signing' });

    let txHash: Hex;
    try {
      txHash = await walletClient.deployContract({
        abi: storageArtifact.abi,
        bytecode: storageArtifact.bytecode as Hex,
        args: [],
        account: address,
      });
    } catch (err) {
      setState({ status: 'error', error: shortError(err) });
      return;
    }
    setState({ status: 'pending', txHash });

    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        setState({ status: 'error', txHash, error: 'Transaction reverted on-chain' });
        return;
      }
      if (!receipt.contractAddress) {
        setState({
          status: 'error',
          txHash,
          error: 'Deploy succeeded but contractAddress missing from receipt',
        });
        return;
      }
      setState({
        status: 'confirmed',
        txHash,
        address: receipt.contractAddress as Address,
      });
    } catch (err) {
      setState({ status: 'error', txHash, error: shortError(err) });
    }
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">What this deploys</h2>
        <p className="text-sm text-white/70">
          A trivial <span className="font-mono">Storage</span> contract — two functions (
          <span className="font-mono">store(uint256)</span> and{' '}
          <span className="font-mono">retrieve()</span>), no state besides a single{' '}
          <span className="font-mono">uint256</span>. Compiled with{' '}
          <span className="font-mono">{storageArtifact.version}</span>, optimizer disabled,{' '}
          <span className="font-mono">evmVersion=london</span>,{' '}
          <span className="font-mono">metadata.bytecodeHash=ipfs</span>.
        </p>
        <p className="mt-2 text-sm text-white/70">
          Its only purpose is to serve as the verification fixture Sourcify runs against Etica
          mainnet during their chain-tests. Once it&apos;s on-chain, we open the Sourcify chain-add
          PR referencing this address; after they merge, any Etica contract can be cross-verified
          via the standard multi-chain Sourcify API.
        </p>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Prerequisites</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-white/70">
          <li>MetaMask installed and unlocked.</li>
          <li>Connected to Etica Mainnet (chain id 61803).</li>
          <li>
            At least <span className="font-mono">~0.01 EGAZ</span> in the deploying wallet — the
            contract is ~360 bytes of runtime bytecode, nothing to speak of.
          </li>
          <li>No constructor args. No ownership. The deployer is irrelevant.</li>
        </ol>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Wallet</h2>
        {!isConnected ? (
          <button
            type="button"
            className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
            onClick={() => injectedConnector && connect({ connector: injectedConnector })}
            disabled={connectStatus === 'pending' || !injectedConnector}
          >
            {connectStatus === 'pending' ? 'Connecting…' : 'Connect Wallet'}
          </button>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-white/60">Connected:</span>
              <span className="font-mono break-all">{address}</span>
              <button
                type="button"
                className="ml-auto rounded-md border border-white/15 px-3 py-1 text-xs text-white/70 hover:bg-white/5"
                onClick={() => disconnect()}
              >
                Disconnect
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-white/60">Chain:</span>
              <span className="font-mono">{chainId}</span>
              {!onMainnet && (
                <button
                  type="button"
                  className="rounded-md bg-amber-400/90 px-3 py-1 text-xs font-medium text-black hover:bg-amber-300"
                  onClick={() => switchChain({ chainId: eticaMainnet.id })}
                  disabled={switching}
                >
                  {switching ? 'Switching…' : 'Switch to Etica Mainnet'}
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Deploy Storage fixture</h2>
        <button
          type="button"
          className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
          onClick={onDeploy}
          disabled={
            !isConnected ||
            !onMainnet ||
            !walletClient ||
            state.status === 'signing' ||
            state.status === 'pending' ||
            state.status === 'confirmed'
          }
        >
          {state.status === 'signing'
            ? 'Sign in wallet…'
            : state.status === 'pending'
              ? 'Waiting for confirmation…'
              : state.status === 'confirmed'
                ? 'Deployed'
                : 'Deploy Storage'}
        </button>
        {state.status === 'error' && state.error && (
          <p className="mt-3 rounded-md border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            {state.error}
          </p>
        )}
        {state.txHash && (
          <p className="mt-3 text-xs text-white/60">
            Tx: <span className="font-mono break-all">{state.txHash}</span>
          </p>
        )}
        {state.status === 'confirmed' && state.address && (
          <div className="mt-4 rounded-md border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm">
            <p className="font-medium text-emerald-200">
              Storage deployed at <span className="font-mono break-all">{state.address}</span>
            </p>
            <p className="mt-1 text-emerald-200/80">
              Copy that address and send it to whoever is opening the Sourcify chain-add PR.
              They&apos;ll paste it into{' '}
              <span className="font-mono">
                services/server/test/chains/sources/storage-contract-chain-addresses.json
              </span>{' '}
              under key <span className="font-mono">&quot;61803&quot;</span>, per the runbook in{' '}
              <span className="font-mono">docs/SOURCIFY_CHAIN_SUBMISSION.md</span>.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
