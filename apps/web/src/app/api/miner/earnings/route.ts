/**
 * GET /api/miner/earnings
 *
 * Live "what a unit of hashrate earns per day" for the two EticaHub pools, so /mine and the desktop
 * miner can show real numbers instead of a guess. Everything is derived from public chain / pool
 * figures and our own price API; nothing is hard-coded except the EGAZ block reward.
 *
 *   EGAZ (etchash, GPU):  networkHashrate = difficulty / blockTime
 *                         coinsPerDayPerMh = 2 EGAZ * 86400 / blockTime / (networkHashrate / 1e6)
 *   ETI  (RandomX, CPU):  networkHashrate = sum of pool hashrates reported by the ETI pool directory
 *                         epochSeconds     = miningDifficulty / networkHashrate
 *                         coinsPerDayPerKh = reward * 86400 / epochSeconds / (networkHashrate / 1e3)
 */
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EGAZ_BLOCK_REWARD = 2;
const EGAZ_STATS = 'https://pool.eticahub.com/api/stats';
const ETI_OVERVIEW = 'https://etipool.eticahub.com/api/v2/pool/overview';
const ETI_NETWORK = 'https://etipool.eticahub.com/api/v2/pool/network';

export interface CoinEarnings {
  priceUsd: number | null;
  networkHashrate: number;
  /** EGAZ: seconds per block. ETI: seconds per solve (epoch). */
  secondsPerReward: number;
  rewardPerSolve: number;
  /** Coins per day for one unit (EGAZ: 1 MH/s, ETI: 1 kH/s). */
  coinsPerDayPerUnit: number;
  usdPerDayPerUnit: number | null;
  unit: 'MH/s' | 'kH/s';
}

export interface MinerEarnings {
  updatedAt: string;
  egaz: CoinEarnings | null;
  eti: CoinEarnings | null;
}

async function getJson<T>(url: string, ms = 8000): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function egazEarnings(priceUsd: number | null): Promise<CoinEarnings | null> {
  const stats = await getJson<{ nodes?: { difficulty?: string; blocktime?: string }[] }>(EGAZ_STATS);
  const node = stats.nodes?.[0];
  const difficulty = Number(node?.difficulty);
  const blockTime = Number(node?.blocktime);
  if (!Number.isFinite(difficulty) || !Number.isFinite(blockTime) || difficulty <= 0 || blockTime <= 0) return null;
  const networkHashrate = difficulty / blockTime;
  const coinsPerDayPerUnit = (EGAZ_BLOCK_REWARD * 86400) / blockTime / (networkHashrate / 1e6);
  return {
    priceUsd,
    networkHashrate,
    secondsPerReward: blockTime,
    rewardPerSolve: EGAZ_BLOCK_REWARD,
    coinsPerDayPerUnit,
    usdPerDayPerUnit: priceUsd === null ? null : coinsPerDayPerUnit * priceUsd,
    unit: 'MH/s',
  };
}

async function etiEarnings(priceUsd: number | null): Promise<CoinEarnings | null> {
  const [overview, network] = await Promise.all([
    getJson<{ poolData?: { miningContract?: { miningDifficulty?: number; miningReward?: string } } }>(ETI_OVERVIEW),
    getJson<{ poolList?: { Hashrate?: number; status?: number }[] }>(ETI_NETWORK),
  ]);
  const contract = overview.poolData?.miningContract;
  const difficulty = Number(contract?.miningDifficulty);
  const reward = Number(contract?.miningReward) / 1e18;
  const networkHashrate = (network.poolList ?? [])
    .filter((p) => p.status === 1)
    .reduce((acc, p) => acc + (Number(p.Hashrate) || 0), 0);
  if (!Number.isFinite(difficulty) || !Number.isFinite(reward) || difficulty <= 0 || reward <= 0 || networkHashrate <= 0) {
    return null;
  }
  const epochSeconds = difficulty / networkHashrate;
  const coinsPerDayPerUnit = (reward * 86400) / epochSeconds / (networkHashrate / 1e3);
  return {
    priceUsd,
    networkHashrate,
    secondsPerReward: epochSeconds,
    rewardPerSolve: reward,
    coinsPerDayPerUnit,
    usdPerDayPerUnit: priceUsd === null ? null : coinsPerDayPerUnit * priceUsd,
    unit: 'kH/s',
  };
}

export async function GET(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;
  const prices = await getJson<{ egaz?: { usdce?: number }; eti?: { usdce?: number } }>(
    `${origin}/api/v1/simple/price?ids=egaz,eti&vs_currencies=usdce`,
  ).catch(() => ({}) as { egaz?: { usdce?: number }; eti?: { usdce?: number } });
  const egazUsd = typeof prices.egaz?.usdce === 'number' ? prices.egaz.usdce : null;
  const etiUsd = typeof prices.eti?.usdce === 'number' ? prices.eti.usdce : null;
  const [egaz, eti] = await Promise.all([
    egazEarnings(egazUsd).catch(() => null),
    etiEarnings(etiUsd).catch(() => null),
  ]);
  const body: MinerEarnings = { updatedAt: new Date().toISOString(), egaz, eti };
  return NextResponse.json(body, {
    headers: { 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' },
  });
}
