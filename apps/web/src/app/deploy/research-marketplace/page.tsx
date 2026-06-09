'use client';

import { useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  encodeDeployData,
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
import { eticaMainnet } from '@etica-hub/shared/chains';
import { DEPLOYMENTS, isSupportedChainId } from '@etica-hub/shared';

import { OperatorBanner } from '@/components/OperatorBanner';
import marketplaceArtifact from '@/lib/etica-research-marketplace-artifact.json';

type DeployState =
  | { status: 'idle' }
  | { status: 'signing' }
  | { status: 'pending'; txHash: Hex }
  | { status: 'confirmed'; txHash: Hex; contractAddress: Address }
  | { status: 'error'; error: string };

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

export default function DeployResearchMarketplacePage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;

  const nftAddr = (() => {
    if (!isSupportedChainId(chainId)) return null;
    return DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS]?.eticaResearchNft ?? null;
  })();

  const existingMarketplace = (() => {
    if (!isSupportedChainId(chainId)) return null;
    const addr = DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS]?.eticaResearchMarketplace;
    return addr && addr !== '0x0000000000000000000000000000000000000000' ? addr : null;
  })();

  const [state, setState] = useState<DeployState>({ status: 'idle' });

  async function deploy() {
    if (!walletClient || !publicClient || !address || !nftAddr) return;
    try {
      setState({ status: 'signing' });
      const data = encodeDeployData({
        abi: marketplaceArtifact.abi,
        bytecode: marketplaceArtifact.bytecode as Hex,
        args: [nftAddr],
      });
      const txHash = await walletClient.sendTransaction({ account: address, data });
      setState({ status: 'pending', txHash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success' || !receipt.contractAddress) {
        throw new Error('Deploy transaction failed');
      }
      setState({
        status: 'confirmed',
        txHash,
        contractAddress: receipt.contractAddress as Address,
      });
    } catch (err) {
      setState({ status: 'error', error: shortError(err) });
    }
  }

  const deploying = state.status === 'signing' || state.status === 'pending';

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Deploy Research NFT Marketplace
        </h1>
        <p className="text-sm text-white/60">
          Deploys the fixed-price marketplace contract for EticaResearchNFT. Sellers list at an EGAZ
          price, buyers pay, and ERC-2981 royalties are automatically forwarded to the per-token
          royalty splitter (79% holder / 20% ancestor cascade / 1% treasury).
        </p>
        <p className="text-sm text-amber-300/80">
          This deploys a real contract on Etica mainnet. No admin, no owner, no pause — immutable
          once deployed.
        </p>
      </header>

      <div className="space-y-6 rounded-xl border border-white/10 bg-white/[0.02] p-6">
        {/* Wallet Connection */}
        {!isConnected ? (
          <div className="space-y-3">
            <p className="text-sm text-white/60">Connect your deployer wallet to begin.</p>
            <div className="flex flex-wrap gap-2">
              {connectors.map((c) => (
                <button
                  key={c.uid}
                  onClick={() => connect({ connector: c })}
                  disabled={connectStatus === 'pending'}
                  className="rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20 disabled:opacity-40"
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <span className="text-white/50">Connected:</span>{' '}
              <span className="font-mono text-white/80">
                {address?.slice(0, 6)}...{address?.slice(-4)}
              </span>
              <span className="ml-2 text-white/40">Chain {chainId}</span>
            </div>
            <button
              onClick={() => disconnect()}
              className="text-xs text-red-400 hover:text-red-300"
            >
              Disconnect
            </button>
          </div>
        )}

        {/* Chain Switch */}
        {isConnected && !onMainnet && (
          <button
            onClick={() => switchChain({ chainId: eticaMainnet.id })}
            disabled={switching}
            className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-300 hover:bg-amber-500/20"
          >
            {switching ? 'Switching...' : `Switch to Etica Mainnet (${eticaMainnet.id})`}
          </button>
        )}

        {/* Contract Info */}
        <div className="space-y-2 rounded-lg border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-white/50">NFT Contract</span>
            <span className="font-mono text-xs text-white/70">
              {nftAddr || 'Not deployed on this chain'}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-white/50">Network</span>
            <span className="text-white/70">
              {chainId === eticaMainnet.id ? 'Etica Mainnet (61803)' : `Chain ${chainId}`}
            </span>
          </div>
          {existingMarketplace && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/50">Existing Marketplace</span>
              <span className="font-mono text-xs text-emerald-300/70">
                {existingMarketplace}
              </span>
            </div>
          )}
        </div>

        {/* Deploy Button */}
        {isConnected && onMainnet && nftAddr && (
          <div className="space-y-3">
            <button
              onClick={deploy}
              disabled={deploying}
              className="w-full rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              {state.status === 'signing'
                ? 'Sign in wallet...'
                : state.status === 'pending'
                  ? 'Deploying...'
                  : 'Deploy Marketplace Contract'}
            </button>
          </div>
        )}

        {/* Success */}
        {state.status === 'confirmed' && (
          <div className="space-y-3 rounded-lg border border-green-500/30 bg-green-500/10 p-4">
            <p className="text-sm font-semibold text-green-300">
              Marketplace Deployed
            </p>
            <div className="space-y-2 text-sm">
              <div>
                <span className="text-white/50">Contract address:</span>
                <p className="font-mono text-green-200 break-all">{state.contractAddress}</p>
              </div>
              <div>
                <span className="text-white/50">Transaction:</span>
                <p className="font-mono text-white/70 break-all">{state.txHash}</p>
              </div>
            </div>
            <div className="mt-3 rounded border border-white/10 bg-black/20 p-3">
              <p className="text-xs text-white/50 mb-2">
                Next: update <span className="font-mono">packages/shared/src/addresses.ts</span>:
              </p>
              <pre className="text-xs text-white/80 overflow-x-auto">
{`eticaResearchMarketplace: '${state.contractAddress}'`}
              </pre>
            </div>
          </div>
        )}

        {/* Error */}
        {state.status === 'error' && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
            <p className="text-sm text-red-300">{state.error}</p>
            <button
              onClick={() => setState({ status: 'idle' })}
              className="mt-2 text-xs text-white/50 hover:text-white/70"
            >
              Try again
            </button>
          </div>
        )}

        {/* CLI fallback */}
        <div className="border-t border-white/5 pt-4">
          <p className="mb-3 text-xs text-white/40">
            Or deploy using Foundry CLI:
          </p>
          <pre className="overflow-x-auto rounded-lg bg-black/50 p-3 text-xs text-emerald-300">
{`forge create src/labs/EticaResearchMarketplace.sol:EticaResearchMarketplace \\
  --rpc-url https://rpc2.etica-stats.org \\
  --private-key $DEPLOYER_PK \\
  --constructor-args ${nftAddr ?? '0x...'}`}
          </pre>
        </div>
      </div>
    </div>
  );
}
