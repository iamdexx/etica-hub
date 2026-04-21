'use client';

import { useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  type Address,
  type Hex,
} from 'viem';
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { DEPLOYMENTS } from '@etica-hub/shared';
import { eticaMainnet } from '@etica-hub/shared/chains';
import { orderRegistryArtifact } from '@/lib/trading-deploy-artifacts';

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

export function DeployOrderbookCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const existing = DEPLOYMENTS[eticaMainnet.id].orderRegistry;
  const alreadyDeployed = existing !== '0x0000000000000000000000000000000000000000';

  const [state, setState] = useState<DeployState>({ status: 'idle' });

  async function onDeploy() {
    if (!walletClient || !publicClient || !address) return;
    setState({ status: 'signing' });

    let txHash: Hex;
    try {
      txHash = await walletClient.deployContract({
        abi: orderRegistryArtifact.abi,
        bytecode: orderRegistryArtifact.bytecode,
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
          A single permissionless <span className="font-mono">OrderRegistry</span> contract
          (8 KB, solc 0.8.29). Anyone can post signed UniswapX orders on-chain; keepers
          discover work by subscribing to the <span className="font-mono">OrderPosted</span>{' '}
          event. No owner, no pausing, no admin surface — the contract is a permanent public
          bulletin board.
        </p>
        <p className="mt-2 text-sm text-white/70">
          The UI doesn&apos;t switch to on-chain posting automatically. After deploy, update{' '}
          <span className="font-mono">DEPLOYMENTS[61803].orderRegistry</span> in{' '}
          <span className="font-mono">packages/shared/src/addresses.ts</span> and ship a
          follow-up PR that wires the trade forms to call{' '}
          <span className="font-mono">postOrder</span> instead of POSTing to the off-chain
          orderbook.
        </p>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Prerequisites</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-white/70">
          <li>MetaMask installed and unlocked.</li>
          <li>Connected to Etica Mainnet (chain id 61803).</li>
          <li>
            At least <span className="font-mono">~0.2 EGAZ</span> in the deploying wallet
            (contract bytecode is ~8 KB).
          </li>
          <li>
            No constructor args, no ownership, no configuration — the deployer&apos;s
            identity doesn&apos;t matter beyond paying gas.
          </li>
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
              <span className="font-mono">{address}</span>
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
        <h2 className="mb-4 text-lg font-semibold">Deploy OrderRegistry</h2>
        {alreadyDeployed && state.status !== 'confirmed' ? (
          <p className="rounded-md border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
            Already deployed at <span className="font-mono">{existing}</span>. Deploying
            again creates a second instance; keepers will only watch the address wired into{' '}
            <span className="font-mono">DEPLOYMENTS</span>.
          </p>
        ) : null}
        <button
          type="button"
          className="mt-3 rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
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
                : 'Deploy OrderRegistry'}
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
              OrderRegistry deployed at <span className="font-mono">{state.address}</span>
            </p>
            <p className="mt-1 text-emerald-200/80">
              Next steps: update{' '}
              <span className="font-mono">DEPLOYMENTS[61803].orderRegistry</span> in{' '}
              <span className="font-mono">packages/shared/src/addresses.ts</span> with this
              address, open a PR, and merge. The trade forms will then wire{' '}
              <span className="font-mono">postOrder</span> automatically (F.7.a.2).
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
