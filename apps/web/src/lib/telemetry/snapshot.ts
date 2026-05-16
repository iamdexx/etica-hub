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
    network: {
      latestBlock: number | null;
      rpcHealthy: boolean;
      state: string;
    };
  };
}

const PUBLIC_RPC =
  process.env.NEXT_PUBLIC_ETICA_RPC_URL ?? 'https://eticamainnet.eticascan.org';

async function fetchLatestBlock(): Promise<number | null> {
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

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();

    if (!payload?.result) {
      return null;
    }

    return parseInt(payload.result, 16);
  } catch {
    return null;
  }
}

export async function buildTelemetrySnapshot(): Promise<TelemetrySnapshot> {
  const latestBlock = await fetchLatestBlock();
  const rpcHealthy = latestBlock !== null;

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
      network: {
        latestBlock,
        rpcHealthy,
        state: rpcHealthy ? 'live' : 'offline',
      },
    },
  };
}
