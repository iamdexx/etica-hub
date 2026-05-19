/**
 * /research-markets/[token] — per-token detail page. Shows full on-chain
 * metadata, bonding-curve stats, and a buy/sell card wired to the
 * EticaResearchMarkets singleton.
 */
import type { Metadata } from 'next';
import { isAddress } from 'viem';
import { notFound } from 'next/navigation';
import { MarketDetail } from '@/components/research-markets/MarketDetail';

export const metadata: Metadata = {
  title: 'Research Market — EticaHub',
};

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isAddress(token)) {
    notFound();
  }
  return <MarketDetail token={token as `0x${string}`} />;
}
