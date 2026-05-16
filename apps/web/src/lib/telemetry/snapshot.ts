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

const PUBLIC_RPC =
  process.env.NEXT_PUBLIC_ETICA_RPC_URL ?? 'https://eticamainnet.eticascan.org';

async function rpcHealthcheck(): Promise<boolean> {
  try {
    const response = await fetch(PUBLIC_RPC, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1,
      }),
      cache: 'no-store',
    });

    return response.ok;
  } catch {
    return false;
  }
}

export async function buildTelemetrySnapshot(): Promise<TelemetrySnapshot> {
  const rpcHealthy = await rpcHealthcheck();

  return {
    generatedAt: new Date().toISOString(),
    network: 'Etica Mainnet',
    chainId: 61803,
    status: rpcHealthy ? 'partial' : 'cron-ready',
    metrics: {
      staking: {
        apy: null,
        tvl: null,
        state: rpcHealthy ? 'rpc-connected' : 'coming-soon',
      },
      farms: {
        apr: null,
        liquidity: null,
        state: rpcHealthy ? 'rpc-connected' : 'coming-soon',
      },
      bridge: {
        volume24h: null,
        transfers: null,
        state: rpcHealthy ? 'rpc-connected' : 'coming-soon',
      },
      governance: {
        proposals: null,
        voters: null,
        state: rpcHealthy ? 'rpc-connected' : 'coming-soon',
      },
    },
  };
}
