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
import { DEPLOYMENTS } from '@etica-hub/shared/addresses';
import eticaResearchNftMetadataArtifact from '@/lib/etica-research-nft-metadata-artifact.json';

type DeployState =
  | { status: 'idle' }
  | { status: 'signing' }
  | { status: 'pending'; txHash: Hex }
  | { status: 'confirmed'; txHash: Hex; libAddress: Address }
  | { status: 'error'; error: string; txHash?: Hex };

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

export function DeployMetadataLibCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const existingLib = onMainnet
    ? DEPLOYMENTS[eticaMainnet.id].eticaResearchNftMetadataLib
    : '0x0000000000000000000000000000000000000000';

  const [state, setState] = useState<DeployState>({ status: 'idle' });

  async function deploy() {
    if (!walletClient || !publicClient || !address) return;
    try {
      setState({ status: 'signing' });
      const data = encodeDeployData({
        abi: eticaResearchNftMetadataArtifact.abi,
        bytecode: eticaResearchNftMetadataArtifact.bytecode as Hex,
        args: [],
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
        libAddress: receipt.contractAddress as Address,
      });
    } catch (err) {
      setState({ status: 'error', error: shortError(err) });
    }
  }

  const deploying =
    state.status === 'signing' || state.status === 'pending';

  return (
    <div className="space-y-6 rounded-xl border border-white/10 bg-white/5 p-6">
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
                className="rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20 disabled:opacity-40"
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
            <span className="ml-2 text-white/40">
              Chain {chainId}
            </span>
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

      {/* Existing library info */}
      {onMainnet && existingLib && existingLib !== '0x0000000000000000000000000000000000000000' && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <p className="text-xs text-white/50 mb-1">Current deployed metadata library</p>
          <p className="font-mono text-sm text-white/70 break-all">{existingLib}</p>
        </div>
      )}

      {/* Deploy Button */}
      {isConnected && onMainnet && (
        <div className="space-y-3">
          <p className="text-sm text-white/60">
            Deploy the updated <span className="font-mono">EticaResearchNFTMetadata</span> library.
            This version renders the protein fold structure as the NFT image and includes all
            research data (hypothesis, approach, references, candidates, fold scores) in the
            description.
          </p>
          <button
            onClick={deploy}
            disabled={deploying}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
          >
            {state.status === 'signing'
              ? 'Sign in wallet...'
              : state.status === 'pending'
                ? 'Deploying...'
                : 'Deploy Metadata Library'}
          </button>
        </div>
      )}

      {/* Success */}
      {state.status === 'confirmed' && (
        <div className="space-y-3 rounded-lg border border-green-500/30 bg-green-500/10 p-4">
          <p className="text-sm font-semibold text-green-300">
            Metadata Library Deployed
          </p>
          <div className="space-y-2 text-sm">
            <div>
              <span className="text-white/50">Library address:</span>
              <p className="font-mono text-green-200 break-all">{state.libAddress}</p>
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
{`eticaResearchNftMetadataLib: '${state.libAddress}'`}
            </pre>
            <p className="mt-2 text-xs text-white/50">
              Then redeploy the NFT contract from{' '}
              <a href="/deploy/research-nft" className="text-blue-400 hover:underline">
                /deploy/research-nft
              </a>{' '}
              with this new library address to activate the fold-render image.
            </p>
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

      {/* What this upgrades */}
      <div className="space-y-2 border-t border-white/10 pt-4">
        <h3 className="text-sm font-medium text-white/70">What this library changes:</h3>
        <ul className="list-disc list-inside space-y-1 text-xs text-white/50">
          <li>
            <strong className="text-white/70">NFT image</strong> → protein fold visualization
            (served from <span className="font-mono">/api/labs/fold-render/[tokenId]</span>)
          </li>
          <li>
            <strong className="text-white/70">Research data</strong> → full record: disease, hypothesis,
            approach, references (PubMed, UniProt, ChEMBL, STRING, KEGG, AlphaFold), all candidates,
            fold scores, structural analysis
          </li>
          <li>
            <strong className="text-white/70">Unchanged</strong> → royalty splits, ancestor cascade,
            claim flow, attributes, animation_url (3D viewer)
          </li>
        </ul>
      </div>
    </div>
  );
}
