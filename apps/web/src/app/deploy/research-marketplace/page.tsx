'use client';

import { useCallback, useState } from 'react';
import { type Address } from 'viem';
import {
  useAccount,
  useChainId,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { eticaMainnet } from '@etica-hub/shared/chains';
import { DEPLOYMENTS, isSupportedChainId } from '@etica-hub/shared';

import { OperatorBanner } from '@/components/OperatorBanner';

// Marketplace bytecode placeholder — deployer will use the creation bytecode
// generated from forge. For now this page provides a manual deploy flow.
// The constructor takes a single address (the NFT contract).

export default function DeployResearchMarketplacePage() {
  const { address: connected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync, data: txHash } = useWriteContract();
  const { isSuccess: confirmed, data: receipt } = useWaitForTransactionReceipt({ hash: txHash });

  const [status, setStatus] = useState<'idle' | 'deploying' | 'done' | 'error'>('idle');
  const [deployedAddr, setDeployedAddr] = useState<Address | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const nftAddr = (() => {
    if (!isSupportedChainId(chainId)) return null;
    return DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS]?.eticaResearchNft ?? null;
  })();

  // After receipt confirmed, extract deployed address
  if (confirmed && receipt && !deployedAddr) {
    // For CREATE deploys, the contract address is in the receipt
    const addr = receipt.contractAddress;
    if (addr) setDeployedAddr(addr);
  }

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

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
        <div className="space-y-2">
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
        </div>

        <div className="border-t border-white/5 pt-4">
          <p className="mb-3 text-xs text-white/40">
            Deploy using Foundry CLI for production:
          </p>
          <pre className="overflow-x-auto rounded-lg bg-black/50 p-3 text-xs text-emerald-300">
{`forge create src/labs/EticaResearchMarketplace.sol:EticaResearchMarketplace \\
  --rpc-url https://rpc2.etica-stats.org \\
  --private-key $DEPLOYER_PK \\
  --constructor-args ${nftAddr ?? '0x...'}`}
          </pre>
        </div>

        {deployedAddr && (
          <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-3">
            <p className="text-xs text-emerald-300">Deployed at:</p>
            <p className="mt-1 break-all font-mono text-sm text-white">{deployedAddr}</p>
          </div>
        )}

        {errorMsg && (
          <div className="rounded-lg border border-rose-400/20 bg-rose-400/5 p-3">
            <p className="text-xs text-rose-300">{errorMsg}</p>
          </div>
        )}
      </div>
    </div>
  );
}
