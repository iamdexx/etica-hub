export interface TelemetrySnapshot {
  generatedAt: string;
  network: string;
  chainId: number;
  status: 'live' | 'partial' | 'cron-ready';
  metrics: {
    staking: {
      apy: number | null;
      tvl: number | null;
      state: string;
    };
    farms: {
      apr: number | null;
      liquidity: number | null;
      state: string;
    };
    bridge: {
      volume24h: number | null;
      transfers: number | null;
      state: string;
    };
    governance: {
      proposals: number | null;
      voters: number | null;
      state: string;
    };
  };
}

export async function buildTelemetrySnapshot(): Promise<TelemetrySnapshot> {
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
