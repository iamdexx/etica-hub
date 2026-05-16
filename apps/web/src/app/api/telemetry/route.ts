import { NextResponse } from 'next/server';

function snapshot() {
  return {
    generatedAt: new Date().toISOString(),
    network: 'Etica Mainnet',
    chainId: 61803,
    status: 'cron-ready',
    metrics: {
      staking: {
        apy: null,
        tvl: null,
        state: 'coming-soon',
      },
      farms: {
        apr: null,
        liquidity: null,
        state: 'coming-soon',
      },
      bridge: {
        volume24h: null,
        transfers: null,
        state: 'coming-soon',
      },
      governance: {
        proposals: null,
        voters: null,
        state: 'coming-soon',
      },
    },
  };
}

export async function GET() {
  return NextResponse.json(snapshot(), {
    headers: {
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
    },
  });
}
