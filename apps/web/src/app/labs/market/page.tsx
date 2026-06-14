'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatEther, parseEther, type Address } from 'viem';
import {
  useAccount,
  useChainId,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { eticaMainnet } from '@etica-hub/shared/chains';
import { DEPLOYMENTS, abis, isSupportedChainId } from '@etica-hub/shared';
import { BranchFromButton } from '@/components/labs/BranchFromButton';

// Minimal ERC-721 ABI for ownerOf / tokenURI / approve / setApprovalForAll
const erc721Abi = [
  {
    type: 'function',
    name: 'ownerOf',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'tokenURI',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isApprovedForAll',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'setApprovalForAll',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'tokenOfOwnerByIndex',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

type ListingData = {
  tokenId: bigint;
  seller: Address;
  price: bigint;
  listedAt: bigint;
};

type NFTMetadata = {
  name?: string;
  description?: string;
  image?: string;
};

function truncateAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function relativeTime(timestamp: bigint): string {
  const delta = Date.now() / 1000 - Number(timestamp);
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

// ─── Marketplace Page ──────────────────────────────────────────────────

export default function MarketPage() {
  const { address: connected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  const marketplaceAddr = useMemo<Address | null>(() => {
    if (!isSupportedChainId(chainId)) return null;
    const addr = DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS]?.eticaResearchMarketplace;
    return addr && addr !== '0x0000000000000000000000000000000000000000' ? addr : null;
  }, [chainId]);

  const nftAddr = useMemo<Address | null>(() => {
    if (!isSupportedChainId(chainId)) return null;
    const addr = DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS]?.eticaResearchNft;
    return addr && addr !== '0x0000000000000000000000000000000000000000' ? addr : null;
  }, [chainId]);

  // ─── Read listings ────────────────────────────────────────────
  const { data: totalListings } = useReadContract({
    address: marketplaceAddr ?? undefined,
    abi: abis.eticaResearchMarketplaceAbi,
    functionName: 'totalListings',
    query: { enabled: !!marketplaceAddr },
  });

  const { data: listingsData, refetch: refetchListings } = useReadContract({
    address: marketplaceAddr ?? undefined,
    abi: abis.eticaResearchMarketplaceAbi,
    functionName: 'getListings',
    args: [0n, 50n],
    query: { enabled: !!marketplaceAddr && (totalListings ?? 0n) > 0n },
  });

  const listings = useMemo<ListingData[]>(() => {
    if (!listingsData) return [];
    const [tokenIds, items] = listingsData as [bigint[], { seller: Address; price: bigint; listedAt: bigint }[]];
    return tokenIds.map((tokenId, i) => ({
      tokenId,
      seller: items[i]!.seller,
      price: items[i]!.price,
      listedAt: items[i]!.listedAt,
    }));
  }, [listingsData]);

  // ─── Fetch user's owned NFTs ────────────────────────────────
  const { data: userBalance } = useReadContract({
    address: nftAddr ?? undefined,
    abi: erc721Abi,
    functionName: 'balanceOf',
    args: connected ? [connected] : undefined,
    query: { enabled: !!connected && !!nftAddr },
  });

  // Query ownerOf for token IDs 1..MAX_SCAN to find user's tokens.
  // The contract uses sequential IDs starting at 1.
  const MAX_TOKEN_SCAN = 200;
  const ownerOfCalls = useMemo(() => {
    if (!nftAddr || !connected || !userBalance || userBalance === 0n) return [];
    return Array.from({ length: MAX_TOKEN_SCAN }, (_, i) => ({
      address: nftAddr as Address,
      abi: erc721Abi,
      functionName: 'ownerOf' as const,
      args: [BigInt(i + 1)],
    }));
  }, [nftAddr, connected, userBalance]);

  const { data: ownerOfResults } = useReadContracts({
    contracts: ownerOfCalls,
    query: { enabled: ownerOfCalls.length > 0 },
  });

  // Filter to get token IDs owned by the connected wallet
  const ownedTokenIds = useMemo<bigint[]>(() => {
    if (!ownerOfResults || !connected) return [];
    const ids: bigint[] = [];
    for (let i = 0; i < ownerOfResults.length; i++) {
      const result = ownerOfResults[i];
      if (
        result?.status === 'success' &&
        typeof result.result === 'string' &&
        result.result.toLowerCase() === connected.toLowerCase()
      ) {
        ids.push(BigInt(i + 1));
      }
    }
    return ids;
  }, [ownerOfResults, connected]);

  // ─── Sell flow state ──────────────────────────────────────────
  const [sellTokenId, setSellTokenId] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [sellStep, setSellStep] = useState<'idle' | 'approving' | 'listing'>('idle');
  const [needsAutoList, setNeedsAutoList] = useState(false);

  // Check approval
  const { data: isApproved } = useReadContract({
    address: nftAddr ?? undefined,
    abi: erc721Abi,
    functionName: 'isApprovedForAll',
    args: connected && marketplaceAddr ? [connected, marketplaceAddr] : undefined,
    query: { enabled: !!connected && !!nftAddr && !!marketplaceAddr },
  });

  // Write: approve
  const { writeContractAsync: approveAsync, data: approveTxHash } = useWriteContract();
  const { isSuccess: approveConfirmed } = useWaitForTransactionReceipt({ hash: approveTxHash });

  // Write: list
  const { writeContractAsync: listAsync, data: listTxHash } = useWriteContract();
  const { isSuccess: listConfirmed } = useWaitForTransactionReceipt({ hash: listTxHash });

  // Write: buy
  const { writeContractAsync: buyAsync, data: buyTxHash } = useWriteContract();
  const { isSuccess: buyConfirmed } = useWaitForTransactionReceipt({ hash: buyTxHash });

  // Write: cancel
  const { writeContractAsync: cancelAsync, data: cancelTxHash } = useWriteContract();
  const { isSuccess: cancelConfirmed } = useWaitForTransactionReceipt({ hash: cancelTxHash });

  // Refetch on confirmed transactions
  useEffect(() => {
    if (listConfirmed || buyConfirmed || cancelConfirmed) {
      refetchListings();
      setSellTokenId('');
      setSellPrice('');
      setSellStep('idle');
    }
  }, [listConfirmed, buyConfirmed, cancelConfirmed, refetchListings]);

  useEffect(() => {
    if (approveConfirmed && sellStep === 'approving') {
      setSellStep('listing');
    }
  }, [approveConfirmed, sellStep]);

  // ─── Handlers ─────────────────────────────────────────────────

  const ensureChain = useCallback(async () => {
    if (chainId !== eticaMainnet.id) {
      await switchChainAsync?.({ chainId: eticaMainnet.id });
    }
  }, [chainId, switchChainAsync]);

  const handleList = useCallback(async () => {
    if (!connected || !marketplaceAddr || !nftAddr) return;
    await ensureChain();
    const tokenId = BigInt(sellTokenId);
    const price = parseEther(sellPrice);

    if (!isApproved) {
      setSellStep('approving');
      setNeedsAutoList(true);
      await approveAsync({
        address: nftAddr,
        abi: erc721Abi,
        functionName: 'setApprovalForAll',
        args: [marketplaceAddr, true],
      });
      return;
    }

    setSellStep('listing');
    await listAsync({
      address: marketplaceAddr,
      abi: abis.eticaResearchMarketplaceAbi,
      functionName: 'list',
      args: [tokenId, price],
    });
  }, [connected, marketplaceAddr, nftAddr, sellTokenId, sellPrice, isApproved, ensureChain, approveAsync, listAsync]);

  // Auto-list after approval (only when the current flow went through approve)
  useEffect(() => {
    if (sellStep === 'listing' && approveConfirmed && needsAutoList && marketplaceAddr) {
      setNeedsAutoList(false);
      const tokenId = BigInt(sellTokenId);
      const price = parseEther(sellPrice);
      listAsync({
        address: marketplaceAddr,
        abi: abis.eticaResearchMarketplaceAbi,
        functionName: 'list',
        args: [tokenId, price],
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveConfirmed, sellStep]);

  const handleBuy = useCallback(
    async (tokenId: bigint, price: bigint) => {
      if (!connected || !marketplaceAddr) return;
      await ensureChain();
      await buyAsync({
        address: marketplaceAddr,
        abi: abis.eticaResearchMarketplaceAbi,
        functionName: 'buy',
        args: [tokenId],
        value: price,
      });
    },
    [connected, marketplaceAddr, ensureChain, buyAsync],
  );

  const handleCancel = useCallback(
    async (tokenId: bigint) => {
      if (!connected || !marketplaceAddr) return;
      await ensureChain();
      await cancelAsync({
        address: marketplaceAddr,
        abi: abis.eticaResearchMarketplaceAbi,
        functionName: 'cancel',
        args: [tokenId],
      });
    },
    [connected, marketplaceAddr, ensureChain, cancelAsync],
  );

  // ─── Render ───────────────────────────────────────────────────

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Research Marketplace</h1>
          <p className="mt-1 text-sm text-white/50">
            Buy and sell peer-reviewed research discoveries. ERC-2981 royalties auto-split to discoverers.
          </p>
        </div>
        <Link
          href="/labs"
          className="rounded-lg border border-white/10 px-4 py-2 text-sm text-white/70 hover:border-white/20 hover:text-white"
        >
          ← Back to Labs
        </Link>
      </div>

      {/* Not deployed notice */}
      {!marketplaceAddr && (
        <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-6 text-center">
          <p className="text-amber-200">
            Marketplace contract not yet deployed on this network.
          </p>
          <Link
            href="/deploy/research-marketplace"
            className="mt-3 inline-block rounded-lg bg-amber-500/20 px-4 py-2 text-sm text-amber-200 hover:bg-amber-500/30"
          >
            Deploy Marketplace →
          </Link>
        </div>
      )}

      {marketplaceAddr && (
        <div className="grid gap-8 lg:grid-cols-3">
          {/* ─── Sell Panel ──────────────────────────────── */}
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-6">
            <h2 className="mb-4 text-lg font-semibold text-white">List for Sale</h2>
            {!connected ? (
              <p className="text-sm text-white/40">Connect wallet to list your research NFTs.</p>
            ) : (
              <div className="space-y-4">
                {/* ── User's NFTs ── */}
                <div>
                  <label className="mb-2 block text-xs font-medium text-white/60">
                    Your Research NFTs
                    {userBalance !== undefined && (
                      <span className="ml-1 text-white/30">({Number(userBalance)})</span>
                    )}
                  </label>
                  {ownedTokenIds.length === 0 ? (
                    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-4 text-center">
                      <p className="text-xs text-white/30">
                        {userBalance === 0n
                          ? 'You don\'t own any research NFTs yet.'
                          : 'Loading your NFTs...'}
                      </p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {ownedTokenIds.map((tokenId) => {
                        const isSelected = sellTokenId === tokenId.toString();
                        const isListed = listings.some((l) => l.tokenId === tokenId);
                        return (
                          <button
                            key={tokenId.toString()}
                            disabled={isListed}
                            onClick={() => setSellTokenId(tokenId.toString())}
                            className={`relative rounded-lg border p-3 text-left transition ${
                              isSelected
                                ? 'border-sky-400/60 bg-sky-500/10'
                                : isListed
                                  ? 'cursor-not-allowed border-white/5 bg-white/[0.01] opacity-40'
                                  : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]'
                            }`}
                          >
                            <span className="block text-xs font-bold text-emerald-300">
                              RES #{tokenId.toString()}
                            </span>
                            {isListed && (
                              <span className="mt-1 block text-[10px] text-amber-300/70">
                                Already listed
                              </span>
                            )}
                            {isSelected && (
                              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-sky-400" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* ── Price Input ── */}
                <div>
                  <label className="mb-1 block text-xs text-white/50">Price (EGAZ)</label>
                  <input
                    type="text"
                    value={sellPrice}
                    onChange={(e) => setSellPrice(e.target.value)}
                    placeholder="e.g. 10.0"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-sky-400/50 focus:outline-none"
                  />
                </div>

                {/* ── List Button ── */}
                <button
                  disabled={!sellTokenId || !sellPrice || sellStep !== 'idle'}
                  onClick={handleList}
                  className="w-full rounded-lg bg-sky-500/20 py-2.5 text-sm font-medium text-sky-200 hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {sellStep === 'approving'
                    ? 'Approving...'
                    : sellStep === 'listing'
                      ? 'Listing...'
                      : !isApproved
                        ? `Approve & List RES #${sellTokenId || '?'}`
                        : `List RES #${sellTokenId || '?'} for Sale`}
                </button>

                {/* ── Branch from the selected NFT (extend the cascade) ── */}
                {sellTokenId && (
                  <div className="border-t border-white/5 pt-3">
                    <p className="mb-2 text-[11px] leading-relaxed text-white/45">
                      Let others build on RES #{sellTokenId}. Branching spawns a child
                      research thread linked to this NFT — when descendants are minted
                      and traded, royalties cascade up to you.
                    </p>
                    <BranchFromButton
                      tokenId={sellTokenId}
                      label={`Branch from RES #${sellTokenId}`}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ─── Listings Grid ───────────────────────────── */}
          <div className="lg:col-span-2">
            <h2 className="mb-4 text-lg font-semibold text-white">
              Active Listings{' '}
              <span className="text-sm font-normal text-white/40">
                ({listings.length})
              </span>
            </h2>

            {listings.length === 0 ? (
              <div className="rounded-xl border border-white/5 bg-white/[0.01] p-10 text-center">
                <p className="text-white/40">No research NFTs listed for sale yet.</p>
                <p className="mt-2 text-xs text-white/25">
                  Be the first to list a research discovery.
                </p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {listings.map((l) => (
                  <ListingCard
                    key={l.tokenId.toString()}
                    listing={l}
                    nftAddr={nftAddr}
                    connected={connected}
                    onBuy={handleBuy}
                    onCancel={handleCancel}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

// ─── Listing Card ───────────────────────────────────────────────────────

function ListingCard({
  listing,
  nftAddr,
  connected,
  onBuy,
  onCancel,
}: {
  listing: ListingData;
  nftAddr: Address | null;
  connected: Address | undefined;
  onBuy: (tokenId: bigint, price: bigint) => void;
  onCancel: (tokenId: bigint) => void;
}) {
  const isSeller = connected?.toLowerCase() === listing.seller.toLowerCase();

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-white/20">
      {/* Token ID badge */}
      <div className="mb-3 flex items-center justify-between">
        <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300">
          RES #{listing.tokenId.toString()}
        </span>
        <span className="text-xs text-white/30">{relativeTime(listing.listedAt)}</span>
      </div>

      {/* Price */}
      <div className="mb-3">
        <p className="text-2xl font-bold text-white">
          {formatEther(listing.price)}{' '}
          <span className="text-sm font-normal text-white/40">EGAZ</span>
        </p>
      </div>

      {/* Seller */}
      <p className="mb-4 text-xs text-white/40">
        Seller: {truncateAddr(listing.seller)}
      </p>

      {/* Action */}
      {isSeller ? (
        <button
          onClick={() => onCancel(listing.tokenId)}
          className="w-full rounded-lg border border-rose-400/20 bg-rose-500/10 py-2 text-sm font-medium text-rose-300 hover:bg-rose-500/20"
        >
          Cancel Listing
        </button>
      ) : connected ? (
        <button
          onClick={() => onBuy(listing.tokenId, listing.price)}
          className="w-full rounded-lg bg-emerald-500/20 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-500/30"
        >
          Buy Now
        </button>
      ) : (
        <p className="text-center text-xs text-white/30">Connect wallet to buy</p>
      )}

      {/* Branch — extend the cascade from this discovery */}
      <div className="mt-3 border-t border-white/5 pt-3">
        <BranchFromButton
          tokenId={listing.tokenId.toString()}
          label="Branch from this"
          compact
        />
      </div>
    </div>
  );
}
