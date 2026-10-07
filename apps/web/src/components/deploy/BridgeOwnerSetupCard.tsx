'use client';

import { useEffect, useState } from 'react';
import { BaseError, UserRejectedRequestError, isAddressEqual, type Address } from 'viem';
import { useAccount, useChainId, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { USDC_WARP_ROUTE, isUsdcWarpRouteLive } from '@etica-hub/shared';
import { eticaMainnet } from '@etica-hub/shared/chains';

const routerOwnerAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'feeRecipient', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'setFeeRecipient',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'recipient', type: 'address' }],
    outputs: [],
  },
] as const;

const ZERO: Address = '0x0000000000000000000000000000000000000000';

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Signature rejected in the wallet.';
  if (err instanceof BaseError) return err.shortMessage;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Post-deploy step only the route owner can do: the deploy workflow signs as
 * the keeper, and `HypERC20.setFeeRecipient` is `onlyOwner` (treasury), so the
 * synthetic router leaves the deploy with no fee recipient — Etica → Ethereum
 * transfers are free until the owner points it at the fee contract.
 */
export function BridgeOwnerSetupCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const live = isUsdcWarpRouteLive();
  const onMainnet = chainId === eticaMainnet.id;
  const router = USDC_WARP_ROUTE.syntheticToken;
  const fee = USDC_WARP_ROUTE.syntheticFee;

  const ownerQuery = useReadContract({
    abi: routerOwnerAbi,
    address: router,
    functionName: 'owner',
    chainId: eticaMainnet.id,
    query: { enabled: live },
  });
  const recipientQuery = useReadContract({
    abi: routerOwnerAbi,
    address: router,
    functionName: 'feeRecipient',
    chainId: eticaMainnet.id,
    query: { enabled: live, refetchInterval: 15_000 },
  });
  const receipt = useWaitForTransactionReceipt({ hash, chainId: eticaMainnet.id, query: { enabled: Boolean(hash) } });

  useEffect(() => {
    if (receipt.isSuccess) void recipientQuery.refetch();
  }, [receipt.isSuccess, recipientQuery]);

  if (!live) return null;

  const owner = ownerQuery.data;
  const recipient = recipientQuery.data;
  const isOwner = Boolean(address && owner && isAddressEqual(address, owner));
  const wired = Boolean(recipient && isAddressEqual(recipient, fee));

  async function setRecipient() {
    if (!address || !isOwner || !onMainnet) return;
    setError(null);
    setSending(true);
    try {
      const h = await writeContractAsync({
        abi: routerOwnerAbi,
        address: router,
        functionName: 'setFeeRecipient',
        args: [fee],
        account: address,
        chainId: eticaMainnet.id,
      });
      setHash(h);
    } catch (err) {
      setError(shortError(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-5">
      <h2 className="text-lg font-semibold">Owner: Etica fee recipient</h2>
      <p className="text-sm text-white/70">
        The USDC.e router <span className="font-mono">{router}</span> must forward fees to{' '}
        <span className="font-mono">{fee}</span> (flat 2 USDC.e + 50 bps, keeper-owned). Only the route
        owner can set it; the deploy workflow could not because it signs as the keeper.
      </p>
      <ul className="space-y-1 text-sm">
        <li className="flex gap-2">
          <span className={wired ? 'text-emerald-400' : 'text-rose-400'}>{wired ? '●' : '○'}</span>
          <span className="text-white/80">Current fee recipient</span>
          <span className="ml-auto font-mono text-xs text-white/50">
            {recipientQuery.isLoading ? 'reading…' : (recipient ?? ZERO) === ZERO ? 'unset (no fee charged)' : recipient}
          </span>
        </li>
        <li className="flex gap-2">
          <span className="text-white/40">·</span>
          <span className="text-white/80">Route owner</span>
          <span className="ml-auto font-mono text-xs text-white/50">{owner ?? '…'}</span>
        </li>
      </ul>
      {wired && <div className="text-sm text-emerald-300">Wired — Etica → Ethereum transfers now pay the fee.</div>}
      {!wired && (
        <div className="space-y-2">
          {!isConnected && <div className="text-xs text-white/50">Connect the owner wallet above to fix this.</div>}
          {isConnected && !isOwner && (
            <div className="text-xs text-amber-300/80">
              Connected wallet is not the route owner; switch to <span className="font-mono">{owner}</span>.
            </div>
          )}
          {isConnected && isOwner && !onMainnet && (
            <button
              onClick={() => switchChain({ chainId: eticaMainnet.id })}
              disabled={switching}
              className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400 disabled:opacity-50"
            >
              {switching ? 'Switching…' : 'Switch to Etica Mainnet'}
            </button>
          )}
          {isConnected && isOwner && onMainnet && (
            <button
              onClick={() => void setRecipient()}
              disabled={sending || receipt.isLoading}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
            >
              {sending ? 'Waiting for wallet…' : receipt.isLoading ? 'Confirming…' : 'Set fee recipient (1 tx, ~0.001 EGAZ)'}
            </button>
          )}
          {hash && (
            <div className="font-mono text-xs break-all text-white/50">
              tx {hash} {receipt.isSuccess ? '— confirmed' : receipt.isError ? '— failed' : ''}
            </div>
          )}
          {error && <div className="text-sm text-rose-300">{error}</div>}
        </div>
      )}
    </section>
  );
}
