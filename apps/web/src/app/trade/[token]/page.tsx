import { notFound } from 'next/navigation';
import { TradeView } from '@/components/trade/TradeView';
import {
  parseTradeBaseSymbol,
  TRADE_BASE_PAIR_IDS,
} from '@/lib/trading/baseSymbol';

export const metadata = { title: 'Trade · EticaHub' };

interface PageProps {
  params: Promise<{ token: string }> | { token: string };
}

export default async function TradeTokenPage({ params }: PageProps) {
  const resolved = await Promise.resolve(params);
  const token = parseTradeBaseSymbol(resolved.token);
  if (!token) notFound();

  // Next.js server components read env at request time.
  const apiBaseUrl = process.env.NEXT_PUBLIC_PRICES_API_URL ?? process.env.PRICES_API_URL ?? '';

  return (
    <TradeView baseSymbol={token} pairId={TRADE_BASE_PAIR_IDS[token]} apiBaseUrl={apiBaseUrl} />
  );
}
