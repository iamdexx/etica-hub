import { notFound } from 'next/navigation';
import { TradeView } from '@/components/trade/TradeView';

export const metadata = { title: 'Trade · EticaHub' };

type SupportedBase = 'ETI' | 'EGAZ';
const PAIR_IDS: Record<SupportedBase, 'ETI-ETX' | 'EGAZ-ETX'> = {
  ETI: 'ETI-ETX',
  EGAZ: 'EGAZ-ETX',
};

function parseToken(raw: string): SupportedBase | null {
  const upper = raw.toUpperCase();
  if (upper === 'ETI' || upper === 'EGAZ') return upper;
  return null;
}

interface PageProps {
  params: Promise<{ token: string }> | { token: string };
}

export default async function TradeTokenPage({ params }: PageProps) {
  const resolved = await Promise.resolve(params);
  const token = parseToken(resolved.token);
  if (!token) notFound();

  // Next.js server components read env at request time.
  const apiBaseUrl = process.env.NEXT_PUBLIC_PRICES_API_URL ?? process.env.PRICES_API_URL ?? '';

  return <TradeView baseSymbol={token} pairId={PAIR_IDS[token]} apiBaseUrl={apiBaseUrl} />;
}
