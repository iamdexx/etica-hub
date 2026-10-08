'use client';

import { useEffect, useState } from 'react';
import { createPublicClient, fallback, formatUnits, http, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import {
  abis,
  DEPLOYMENTS,
  eticaMainnet,
  USDC_WARP_ROUTE,
  isUsdcWarpRouteLive,
} from '@etica-hub/shared';
import { ETHEREUM_BROWSER_RPCS } from '@/lib/bridge/ethereum-rpcs';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
/** Where the seed LP was minted; nothing at this address can ever be withdrawn. */
const DEAD_ADDRESS: Address = '0x000000000000000000000000000000000000dEaD';

interface EthereumSide {
  locked: bigint;
  pendingFees: bigint;
}

interface EticaSide {
  supply: bigint;
  pendingFees: bigint;
  pool: { address: Address; usdce: bigint; etx: bigint; lpBurnedBps: number } | null;
}

type Loaded<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error' };

function fmtUsdc(raw: bigint): string {
  return Number(formatUnits(raw, USDC_WARP_ROUTE.decimals)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtEtx(raw: bigint): string {
  return Number(formatUnits(raw, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

async function readEthereum(): Promise<EthereumSide> {
  const client = createPublicClient({
    chain: mainnet,
    transport: fallback(
      ETHEREUM_BROWSER_RPCS.map((url) => http(url, { timeout: 8_000, retryCount: 1 })),
      { rank: true },
    ),
  });
  const [locked, pendingFees] = await Promise.all([
    client.readContract({
      abi: abis.erc20Abi,
      address: USDC_WARP_ROUTE.collateralToken,
      functionName: 'balanceOf',
      args: [USDC_WARP_ROUTE.collateralRouter],
    }) as Promise<bigint>,
    client.readContract({
      abi: abis.erc20Abi,
      address: USDC_WARP_ROUTE.collateralToken,
      functionName: 'balanceOf',
      args: [USDC_WARP_ROUTE.collateralFee],
    }) as Promise<bigint>,
  ]);
  return { locked, pendingFees };
}

async function readEtica(): Promise<EticaSide> {
  const d = DEPLOYMENTS[eticaMainnet.id];
  const client = createPublicClient({ chain: eticaMainnet, transport: http() });
  const usdce = USDC_WARP_ROUTE.syntheticToken;
  const [supply, pendingFees, pair] = await Promise.all([
    client.readContract({ abi: abis.erc20Abi, address: usdce, functionName: 'totalSupply' }) as Promise<bigint>,
    client.readContract({
      abi: abis.erc20Abi,
      address: usdce,
      functionName: 'balanceOf',
      args: [USDC_WARP_ROUTE.syntheticFee],
    }) as Promise<bigint>,
    client.readContract({
      abi: abis.factoryAbi,
      address: d.swapFactory,
      functionName: 'getPair',
      args: [usdce, d.etx],
    }) as Promise<Address>,
  ]);
  if (pair === ZERO) return { supply, pendingFees, pool: null };
  const [reserves, token0, lpSupply, lpBurned] = await Promise.all([
    client.readContract({ abi: abis.pairAbi, address: pair, functionName: 'getReserves' }) as Promise<
      readonly [bigint, bigint, number]
    >,
    client.readContract({ abi: abis.pairAbi, address: pair, functionName: 'token0' }) as Promise<Address>,
    client.readContract({ abi: abis.pairAbi, address: pair, functionName: 'totalSupply' }) as Promise<bigint>,
    client.readContract({
      abi: abis.pairAbi,
      address: pair,
      functionName: 'balanceOf',
      args: [DEAD_ADDRESS],
    }) as Promise<bigint>,
  ]);
  const usdceIsToken0 = token0.toLowerCase() === usdce.toLowerCase();
  return {
    supply,
    pendingFees,
    pool: {
      address: pair,
      usdce: usdceIsToken0 ? reserves[0] : reserves[1],
      etx: usdceIsToken0 ? reserves[1] : reserves[0],
      lpBurnedBps: lpSupply === 0n ? 0 : Number((lpBurned * 10_000n) / lpSupply),
    },
  };
}

export function UsdcRouteStatusBoard() {
  const [eth, setEth] = useState<Loaded<EthereumSide>>({ status: 'loading' });
  const [etica, setEtica] = useState<Loaded<EticaSide>>({ status: 'loading' });
  const live = isUsdcWarpRouteLive();

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    void readEthereum().then(
      (data) => !cancelled && setEth({ status: 'ready', data }),
      () => !cancelled && setEth({ status: 'error' }),
    );
    void readEtica().then(
      (data) => !cancelled && setEtica({ status: 'ready', data }),
      () => !cancelled && setEtica({ status: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [live]);

  if (!live) {
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-amber-200/80">
        The USDC.e route is not wired on this deployment.
      </div>
    );
  }

  const locked = eth.status === 'ready' ? eth.data.locked : null;
  const supply = etica.status === 'ready' ? etica.data.supply : null;
  const backing =
    locked !== null && supply !== null
      ? supply === 0n
        ? 'No USDC.e minted yet'
        : locked >= supply
          ? 'Fully backed'
          : 'Under-collateralised'
      : null;
  const backingTone: Tone = backing === 'Under-collateralised' ? 'warn' : 'ok';

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-widest text-white/40">Collateral</div>
          {backing ? (
            <span className={`text-xs ${backingTone === 'ok' ? 'text-emerald-300' : 'text-amber-300'}`}>{backing}</span>
          ) : null}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="USDC locked (Ethereum)" value={cell(eth, (d) => `${fmtUsdc(d.locked)} USDC`)} />
          <Stat label="USDC.e supply (Etica)" value={cell(etica, (d) => `${fmtUsdc(d.supply)} USDC.e`)} />
          <Stat label="Fees pending, Ethereum" value={cell(eth, (d) => `${fmtUsdc(d.pendingFees)} USDC`)} />
          <Stat label="Fees pending, Etica" value={cell(etica, (d) => `${fmtUsdc(d.pendingFees)} USDC.e`)} />
        </div>
        <div className="mt-3 text-xs text-white/40">
          Read live from both chains. Pending fees are swept hourly by the keeper into relayer gas and EGAZ.
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="text-xs uppercase tracking-widest text-white/40">USDC.e / ETX pool</div>
        {etica.status === 'ready' && etica.data.pool ? (
          <>
            <div className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <Stat label="USDC.e reserve" value={`${fmtUsdc(etica.data.pool.usdce)} USDC.e`} />
              <Stat label="ETX reserve" value={`${fmtEtx(etica.data.pool.etx)} ETX`} />
              <Stat
                label="LP burned"
                value={`${(etica.data.pool.lpBurnedBps / 100).toFixed(2)}%`}
                tone={etica.data.pool.lpBurnedBps >= 9_900 ? 'ok' : undefined}
              />
            </div>
            <div className="mt-3 text-xs text-white/40">
              Pair{' '}
              <a href={`/pools/${etica.data.pool.address}`} className="font-mono text-brand-accent hover:underline">
                {etica.data.pool.address.slice(0, 6)}…{etica.data.pool.address.slice(-4)}
              </a>
              . LP sent to the dead address can never be withdrawn.
            </div>
          </>
        ) : (
          <div className="mt-2 text-sm text-white/50">
            {etica.status === 'loading' ? '…' : etica.status === 'error' ? 'Etica RPC unreachable' : 'No pool yet'}
          </div>
        )}
      </div>
    </div>
  );
}

type Tone = 'ok' | 'warn';

function cell<T>(state: Loaded<T>, render: (d: T) => string): string {
  if (state.status === 'loading') return '…';
  if (state.status === 'error') return 'unavailable';
  return render(state.data);
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  const color = tone === 'ok' ? 'text-emerald-200' : tone === 'warn' ? 'text-amber-200' : 'text-white';
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-white/40">{label}</div>
      <div className={`mt-0.5 font-medium ${color}`}>{value}</div>
    </div>
  );
}
