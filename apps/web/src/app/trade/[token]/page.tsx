import Link from 'next/link';
import { PageHero } from '@/components/PageHero';
import { notFound } from 'next/navigation';
import { isAddress, getAddress, type Address } from 'viem';
import { TradeView } from '@/components/trade/TradeView';
import { ResearchMarketTradeContainer } from '@/components/research-markets/ResearchMarketTradeContainer';
import {
  TelemetrySection,
  SourceBadge,
  UnavailableMetric,
} from '@/components/telemetry/TelemetryCards';
import { parseTradeBaseSymbol, TRADE_BASE_PAIR_IDS } from '@/lib/trading/baseSymbol';

export const metadata = { title: 'Trade · EticaHub' };

interface PageProps {
  params: Promise<{ token: string }> | { token: string };
}

export default async function TradeTokenPage({ params }: PageProps) {
  const resolved = await Promise.resolve(params);

  // Address-style slugs route to the bonding-curve trade view (research
  // markets). Symbol-style slugs route to the standard order-stack
  // trading terminal (ETI / EGAZ / stETX).
  if (isAddress(resolved.token)) {
    const checksummed = getAddress(resolved.token) as Address;
    return <ResearchMarketTokenPage token={checksummed} />;
  }

  const token = parseTradeBaseSymbol(resolved.token);
  if (!token) notFound();

  const apiBaseUrl = process.env.NEXT_PUBLIC_PRICES_API_URL ?? process.env.PRICES_API_URL ?? '';
  const pairId = TRADE_BASE_PAIR_IDS[token];
  const signals = [
    {
      label: 'Order types',
      value: 'Limit · Stop · DCA',
      detail: 'Trading engine supported modes',
      tone: 'amber' as const,
    },
    {
      label: 'Strategy',
      value: 'Grid · Infinity',
      detail: 'Advanced strategy surfaces',
      tone: 'amber' as const,
    },
    { label: 'Settlement', value: 'Permit2 + UniswapX', detail: 'Configured execution stack' },
    {
      label: 'Live volume',
      value: <UnavailableMetric reason="requires trade indexer" />,
      detail: 'Pair-indexed fills pending',
    },
  ];

  return (
    <div className="space-y-6">
      <PageHero
        tone="amber"
        eyebrow={`Trading Terminal · ${token}`}
        title={<>{token} execution desk.</>}
        description={
          <>
            Trade {token} with routed execution, order strategy surfaces, Infinity Bot positioning,
            and a fast path into pair analytics before submitting orders.
          </>
        }
        actions={
          <>
            <Link href="/explorer/pairs" className="btn-tone px-3.5 py-1.5 text-xs">
              Pair analytics
            </Link>
            <Link href="/swap" className="btn-ghost px-3.5 py-1.5 text-xs">
              Quick swap
            </Link>
            <Link href="/pool" className="btn-primary px-3.5 py-1.5 text-xs">
              Liquidity
            </Link>
          </>
        }
        aside={
          <TelemetrySection
            title="Execution telemetry"
            badge={<SourceBadge tone="amber">{pairId}</SourceBadge>}
            metrics={signals}
            description="Configured execution modes are shown from app config. Pair-level fills, spread, and routed volume require the trade indexer before live values can be displayed."
          />
        }
      />

      <section className="grid gap-6 lg:grid-cols-[0.72fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <div className="surface p-5">
            <div className="text-[11px] uppercase tracking-eyebrow text-white/45">Desk context</div>
            <div className="mt-4 space-y-3">
              <InfoCard
                title="Routed markets"
                body="Use the Explorer pair analytics before opening or adjusting execution strategies."
              />
              <InfoCard
                title="Advanced orders"
                body="Limit, stop, DCA, grid, and Infinity surfaces remain available through the existing trading engine."
              />
              <InfoCard
                title="Risk visibility"
                body="Keep strategy controls next to chain, pair, and liquidity context instead of isolated tabs."
              />
            </div>
          </div>
        </aside>
        <div className="surface p-3">
          <TradeView baseSymbol={token} pairId={pairId} apiBaseUrl={apiBaseUrl} />
        </div>
      </section>
    </div>
  );
}

function InfoCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="surface-2 p-4">
      <div className="text-sm font-semibold text-white">{title}</div>
      <p className="mt-2 text-xs leading-5 text-white/55">{body}</p>
    </div>
  );
}

/**
 * Page chrome for graduated research-token trade pages. Rendered when the
 * dynamic `[token]` slug parses as a 20-byte address. The actual buy/sell
 * UX is owned by `<ResearchMarketTradeContainer />`, which guards behind
 * graduation status and falls back to the launchpad link for non-graduated
 * tokens.
 */
function ResearchMarketTokenPage({ token }: { token: Address }) {
  const signals = [
    {
      label: 'Venue',
      value: 'Bonding curve',
      detail: 'Singleton-hosted (no LP)',
      tone: 'emerald' as const,
    },
    { label: 'Settlement', value: 'On-chain swap', detail: '1% fee · 1% slippage default' },
    { label: 'Backing pool', value: 'Shared 5M ETX', detail: 'Common to all research markets' },
    { label: 'Order types', value: 'Buy · Sell', detail: 'Advanced orders unavailable for curves' },
  ];
  return (
    <div className="space-y-6">
      <PageHero
        tone="emerald"
        eyebrow="Research-market terminal"
        title="Graduated bonding curve."
        description="This is a research-token market backed by the shared 5M ETX
                pool. Trades route through the EticaResearchMarkets
                singleton — no external LP, no Dutch order, no keeper.
                Buy/sell at the live curve quote with a 1% slippage floor."
        actions={
          <>
            <Link href={`/research-markets/${token}`} className="btn-tone px-3.5 py-1.5 text-xs">
              Launchpad view
            </Link>
            <Link href="/research-markets" className="btn-ghost px-3.5 py-1.5 text-xs">
              All markets
            </Link>
            <Link href="/swap" className="btn-primary px-3.5 py-1.5 text-xs">
              Quick swap
            </Link>
          </>
        }
        aside={
          <TelemetrySection
            title="Curve telemetry"
            badge={<SourceBadge tone="emerald">ETX ↔ research token</SourceBadge>}
            metrics={signals}
            description="Research markets settle inline against the bonding curve. Order-stack surfaces (Limit / Stop / DCA / Grid / Infinity) are hidden on this view because the singleton-only venue cannot fill them."
          />
        }
      />

      <section className="grid gap-6 lg:grid-cols-[0.72fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <div className="surface p-5">
            <div className="text-[11px] uppercase tracking-eyebrow text-white/45">Desk context</div>
            <div className="mt-4 space-y-3">
              <InfoCard
                title="Bonding curve venue"
                body="Trades settle inside the EticaResearchMarkets singleton — every buy mints, every sell burns against the shared 5M ETX pool."
              />
              <InfoCard
                title="Listing criterion"
                body="Tokens appear on the trade terminal only after crossing the 100k ETX graduation threshold."
              />
              <InfoCard
                title="Verifiability"
                body="Token bytecode is auto-published to Sourcify on launch. Metadata, evidence, and socials live on-chain."
              />
            </div>
          </div>
        </aside>
        <div className="surface p-3">
          <ResearchMarketTradeContainer token={token} />
        </div>
      </section>
    </div>
  );
}
// `Suppress` unused import warnings — `UnavailableMetric` is still imported but
// only used by the standard symbol page above.
void UnavailableMetric;
