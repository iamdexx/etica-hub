import type { Metadata } from 'next';
import { StatusPanel } from '@/components/StatusPanel';
import { StatusAutoRefresh } from '@/components/StatusAutoRefresh';
import {
  StatusLiquidityFlowCard,
  StatusRevenueCard,
} from '@/components/StatusRevenueCards';
import { StatusMarketCharts } from '@/components/StatusMarketCharts';

// Always fetch fresh on each request — this is a live on-chain diagnostic
// and we don't want the Vercel build to try (and fail) to hit an Etica RPC
// at build time.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Status · EticaHub',
  description:
    'Live on-chain diagnostic of EticaHub v1 mainnet deployment — factory, router, ETX, pools, reserves.',
};

export default function StatusPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Mainnet status</h1>
        <p className="text-sm text-white/60">
          Live, wallet-less read of EticaHub&apos;s core v1 contracts and pools on Etica Mainnet
          (chain 61803). Values are pulled from an Etica RPC when you load this page.
        </p>
      </header>
      <StatusAutoRefresh />
      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <StatusRevenueCard />
        <StatusLiquidityFlowCard />
      </div>
      <div className="mb-6">
        <StatusMarketCharts />
      </div>
      <StatusPanel />
    </div>
  );
}
