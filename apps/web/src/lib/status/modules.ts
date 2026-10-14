import { createPublicClient, fallback, formatUnits, http, parseAbi, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import {
  BRIDGE_ROLES,
  DEPLOYMENTS,
  eticaMainnet,
  USDC_WARP_ROUTE,
  isUsdcWarpRouteLive,
} from '@etica-hub/shared';
import { ETHEREUM_PUBLIC_RPCS } from '@/lib/bridge/ethereum-rpcs';
import { computeHealth, type HealthReport } from '@/lib/health';
import { fetchIndexedCursor, type IndexedCursor } from '@/lib/explorerIndex';
import { getArchiveStats, type ArchiveStats } from '@/lib/labs/archive';
import { labsQueue } from '@/lib/labs/queue';
import { failoverTransport } from '@/lib/rpc';

export type ModuleState = 'ok' | 'warn' | 'down' | 'na';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const READ_TIMEOUT_MS = 15_000;

const erc20Abi = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const factoryAbi = parseAbi(['function getPair(address, address) view returns (address)']);
const pairAbi = parseAbi([
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function token0() view returns (address)',
]);
const vaultAbi = parseAbi([
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]);
const farmsAbi = parseAbi([
  'function poolLength() view returns (uint256)',
  'function totalAllocPoint() view returns (uint256)',
]);

function eticaClient() {
  return createPublicClient({ chain: eticaMainnet, transport: failoverTransport(eticaMainnet) });
}

function ethereumClient() {
  return createPublicClient({
    chain: mainnet,
    transport: fallback(
      ETHEREUM_PUBLIC_RPCS.map((url) => http(url, { timeout: 8_000, retryCount: 1 })),
    ),
  });
}

function deployments() {
  const d = DEPLOYMENTS[eticaMainnet.id];
  if (!d || d.etx === ZERO) throw new Error('Mainnet addresses not wired into shared package.');
  return d;
}

export function withTimeout<T>(p: Promise<T>, ms = READ_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function fmtAmount(raw: bigint, decimals: number, maxFraction = 2): string {
  const n = Number(formatUnits(raw, decimals));
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFraction });
}

export function fmtAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* ------------------------------------------------------------------ */
/*  Chain                                                              */
/* ------------------------------------------------------------------ */

export async function loadChain(): Promise<HealthReport> {
  return withTimeout(computeHealth());
}

/* ------------------------------------------------------------------ */
/*  DEX                                                                */
/* ------------------------------------------------------------------ */

export interface DexModule {
  pairCount: bigint;
  usdcePool: { usdce: bigint; etx: bigint } | null;
  stableswap: { stEtx: bigint; etx: bigint } | null;
}

export async function loadDex(): Promise<DexModule> {
  const d = deployments();
  const client = eticaClient();
  const read = client.readContract.bind(client);

  const [pairCount, usdcePair, stableStEtx, stableEtx] = await withTimeout(
    Promise.all([
      read({
        abi: parseAbi(['function allPairsLength() view returns (uint256)']),
        address: d.swapFactory,
        functionName: 'allPairsLength',
      }),
      isUsdcWarpRouteLive()
        ? read({
            abi: factoryAbi,
            address: d.swapFactory,
            functionName: 'getPair',
            args: [USDC_WARP_ROUTE.syntheticToken, d.etx],
          })
        : Promise.resolve(ZERO),
      d.eticaStableSwap !== ZERO && d.stakedETX !== ZERO
        ? read({
            abi: erc20Abi,
            address: d.stakedETX,
            functionName: 'balanceOf',
            args: [d.eticaStableSwap],
          })
        : Promise.resolve(null),
      d.eticaStableSwap !== ZERO
        ? read({
            abi: erc20Abi,
            address: d.etx,
            functionName: 'balanceOf',
            args: [d.eticaStableSwap],
          })
        : Promise.resolve(null),
    ]),
  );

  let usdcePool: DexModule['usdcePool'] = null;
  if (usdcePair !== ZERO) {
    const [reserves, token0] = await withTimeout(
      Promise.all([
        read({ abi: pairAbi, address: usdcePair, functionName: 'getReserves' }),
        read({ abi: pairAbi, address: usdcePair, functionName: 'token0' }),
      ]),
    );
    const usdceIs0 = token0.toLowerCase() === USDC_WARP_ROUTE.syntheticToken.toLowerCase();
    usdcePool = usdceIs0
      ? { usdce: reserves[0], etx: reserves[1] }
      : { usdce: reserves[1], etx: reserves[0] };
  }

  return {
    pairCount,
    usdcePool,
    stableswap:
      stableStEtx != null && stableEtx != null ? { stEtx: stableStEtx, etx: stableEtx } : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Staking + farms                                                    */
/* ------------------------------------------------------------------ */

export interface StakingModule {
  totalAssets: bigint;
  totalShares: bigint;
  /** ETX per stETX, 1e18 scaled. */
  rate: bigint;
  farmPools: bigint | null;
  farmAllocPoint: bigint | null;
}

export async function loadStaking(): Promise<StakingModule> {
  const d = deployments();
  if (d.stakedETX === ZERO) throw new Error('stETX vault not deployed');
  const client = eticaClient();
  const read = client.readContract.bind(client);
  const [totalAssets, totalShares, farmPools, farmAllocPoint] = await withTimeout(
    Promise.all([
      read({ abi: vaultAbi, address: d.stakedETX, functionName: 'totalAssets' }),
      read({ abi: vaultAbi, address: d.stakedETX, functionName: 'totalSupply' }),
      d.etxFarms !== ZERO
        ? read({ abi: farmsAbi, address: d.etxFarms, functionName: 'poolLength' })
        : Promise.resolve(null),
      d.etxFarms !== ZERO
        ? read({ abi: farmsAbi, address: d.etxFarms, functionName: 'totalAllocPoint' })
        : Promise.resolve(null),
    ]),
  );
  const rate = totalShares === 0n ? 10n ** 18n : (totalAssets * 10n ** 18n) / totalShares;
  return { totalAssets, totalShares, rate, farmPools, farmAllocPoint };
}

/* ------------------------------------------------------------------ */
/*  Bridge                                                             */
/* ------------------------------------------------------------------ */

export interface BridgeModule {
  live: boolean;
  usdceSupply: bigint | null;
  usdcLocked: bigint | null;
  ethereumError: string | null;
  keeperEgaz: bigint;
  relayerEgaz: bigint;
  validatorEgaz: bigint;
  relayerEth: bigint | null;
}

export async function loadBridge(): Promise<BridgeModule> {
  const live = isUsdcWarpRouteLive();
  const etica = eticaClient();
  const [usdceSupply, keeperEgaz, relayerEgaz, validatorEgaz] = await withTimeout(
    Promise.all([
      live
        ? etica.readContract({
            abi: erc20Abi,
            address: USDC_WARP_ROUTE.syntheticToken,
            functionName: 'totalSupply',
          })
        : Promise.resolve(null),
      etica.getBalance({ address: BRIDGE_ROLES.keeper }),
      etica.getBalance({ address: BRIDGE_ROLES.relayer }),
      etica.getBalance({ address: BRIDGE_ROLES.validator }),
    ]),
  );

  let usdcLocked: bigint | null = null;
  let relayerEth: bigint | null = null;
  let ethereumError: string | null = null;
  if (live) {
    try {
      const eth = ethereumClient();
      [usdcLocked, relayerEth] = await withTimeout(
        Promise.all([
          eth.readContract({
            abi: erc20Abi,
            address: USDC_WARP_ROUTE.collateralToken,
            functionName: 'balanceOf',
            args: [USDC_WARP_ROUTE.collateralRouter],
          }),
          eth.getBalance({ address: BRIDGE_ROLES.relayer }),
        ]),
      );
    } catch (err) {
      ethereumError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    live,
    usdceSupply,
    usdcLocked,
    ethereumError,
    keeperEgaz,
    relayerEgaz,
    validatorEgaz,
    relayerEth,
  };
}

/* ------------------------------------------------------------------ */
/*  Labs                                                               */
/* ------------------------------------------------------------------ */

export interface LabsModule {
  stats: ArchiveStats;
  pending: number | null;
}

export async function loadLabs(): Promise<LabsModule> {
  const [stats, pending] = await withTimeout(
    Promise.all([
      getArchiveStats(),
      labsQueue()
        .pendingCount()
        .catch(() => null),
    ]),
  );
  return { stats, pending };
}

/* ------------------------------------------------------------------ */
/*  Explorer indexer                                                   */
/* ------------------------------------------------------------------ */

export interface IndexerModule {
  cursor: IndexedCursor | null;
  headBlock: bigint | null;
}

export async function loadIndexer(): Promise<IndexerModule> {
  const [cursor, headBlock] = await withTimeout(
    Promise.all([
      fetchIndexedCursor(),
      eticaClient()
        .getBlockNumber()
        .catch(() => null),
    ]),
  );
  return { cursor, headBlock };
}

/* ------------------------------------------------------------------ */
/*  Automation (GitHub Actions crons)                                  */
/* ------------------------------------------------------------------ */

export const AUTOMATION_WORKFLOWS = [
  { file: 'bridge-monitor.yml', label: 'Bridge monitor', every: '5 min' },
  { file: 'bridge-heartbeat.yml', label: 'Bridge heartbeat', every: '15 min' },
  { file: 'bridge-gas.yml', label: 'Bridge gas keeper', every: '1 h' },
  { file: 'keeper.yml', label: 'Farm keeper', every: '5 min' },
  { file: 'labs-autopilot.yml', label: 'Labs autopilot', every: '5 min' },
  { file: 'labs-forfeit.yml', label: 'Labs forfeit sweep', every: '1 h' },
  { file: 'explorer-indexer.yml', label: 'Explorer indexer', every: '10 min' },
  { file: 'ops-alerts.yml', label: 'Ops alerts', every: '10 min' },
  { file: 'harvest.yml', label: 'Treasury harvest', every: 'daily' },
] as const;

export interface WorkflowRun {
  label: string;
  every: string;
  conclusion: string | null;
  status: string | null;
  updatedAt: string | null;
  url: string | null;
  error: string | null;
}

const GITHUB_REPO = 'iamdexx/etica-hub';
/** Unauthenticated GitHub API allows 60 req/h per IP; 9 workflows every 15 min stays under it. */
const GITHUB_REVALIDATE_SECONDS = 15 * 60;

interface GitHubRunsResponse {
  workflow_runs?: Array<{
    conclusion: string | null;
    status: string;
    updated_at: string;
    html_url: string;
  }>;
  message?: string;
}

/** Optional read-only token (`GITHUB_STATUS_TOKEN`) lifts the 60 req/h anonymous limit to 5000. */
function githubHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'eticahub-status',
  };
  const token = process.env.GITHUB_STATUS_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export async function loadAutomation(): Promise<WorkflowRun[]> {
  return Promise.all(
    AUTOMATION_WORKFLOWS.map(async (wf): Promise<WorkflowRun> => {
      const base = { label: wf.label, every: wf.every };
      try {
        const res = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${wf.file}/runs?per_page=1&exclude_pull_requests=true`,
          {
            headers: githubHeaders(),
            next: { revalidate: GITHUB_REVALIDATE_SECONDS },
          },
        );
        const body = (await res.json()) as GitHubRunsResponse;
        if (!res.ok) {
          return {
            ...base,
            conclusion: null,
            status: null,
            updatedAt: null,
            url: null,
            error: (body.message ?? `HTTP ${res.status}`).split('.')[0] || `HTTP ${res.status}`,
          };
        }
        const run = body.workflow_runs?.[0];
        if (!run)
          return {
            ...base,
            conclusion: null,
            status: null,
            updatedAt: null,
            url: null,
            error: 'no runs',
          };
        return {
          ...base,
          conclusion: run.conclusion,
          status: run.status,
          updatedAt: run.updated_at,
          url: run.html_url,
          error: null,
        };
      } catch (err) {
        return {
          ...base,
          conclusion: null,
          status: null,
          updatedAt: null,
          url: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
