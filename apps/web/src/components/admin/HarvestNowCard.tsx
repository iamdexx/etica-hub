'use client';

/**
 * Public "Harvest now" card for /admin/harvester.
 *
 * `TreasuryHarvester.harvest(pools)` is permissionless — any wallet can
 * call it. The keeper cron is the default cadence runner; this card is
 * the manual fallback when the cron is paused, when seeding the very
 * first run, or when an operator wants to crank an extra harvest within
 * the cooldown window has elapsed.
 *
 * The component reads the on-chain config + pair snapshots, builds the
 * `PoolPlan[]` calldata client-side (mirroring the keeper's
 * delegation-mode plan), and calls `harvest(pools)` from the connected
 * wallet. The treasury wallet is the natural caller because it pays gas,
 * but ANY wallet works — the contract enforces every safety boundary.
 */

import { useEffect, useMemo, useState } from 'react';
import { BaseError, UserRejectedRequestError, type Address, type Hex } from 'viem';
import { useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi';
import { abis, DEPLOYMENTS } from '@etica-hub/shared';
import { eticaMainnet } from '@etica-hub/shared/chains';

const harvesterAbi = abis.treasuryHarvesterAbi;
const factoryAbi = abis.factoryAbi;
const pairAbi = abis.pairAbi;

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const ETI_ADDRESS: Address = '0x34c61EA91bAcdA647269d4e310A86b875c09946f';

type TxState = {
  status: 'idle' | 'signing' | 'pending' | 'confirmed' | 'error';
  txHash?: Hex;
  error?: string;
};

type PoolSnapshot = {
  label: string;
  pair: Address;
  nonEtx: Address;
  reserveEtx: bigint;
  reserveNonEtx: bigint;
  totalSupply: bigint;
  treasuryLp: bigint;
};

type HarvesterCfg = {
  maxBurnBps: number;
  stakedBps: number;
  farmsBps: number;
  polBps: number;
  treasuryBps: number;
  cooldown: number;
  lastHarvestAt: bigint;
};

type PoolPlan = {
  pair: Address;
  nonEtx: Address;
  lpToBurn: bigint;
  minEtxFromBurn: bigint;
  minNonEtxFromBurn: bigint;
  minEtxFromSwap: bigint;
  polEtxForSwap: bigint;
  polEtxForPair: bigint;
  minNonEtxFromPolSwap: bigint;
};

const DEFAULT_SLIPPAGE_BPS = 300;

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

function withSlippage(quote: bigint, bps: number): bigint {
  if (bps <= 0 || quote === 0n) return quote;
  return (quote * BigInt(10_000 - bps)) / 10_000n;
}

/** UniswapV2 swap output: out = reserveOut * amountIn * 997 / (reserveIn * 1000 + amountIn * 997). */
function estimateSwapOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n;
  const aWithFee = amountIn * 997n;
  return (aWithFee * reserveOut) / (reserveIn * 1000n + aWithFee);
}

function fmtEtx(wei: bigint, etxUsd: number | null): string {
  const etx = Number(wei) / 1e18;
  const human = etx >= 1
    ? etx.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : etx.toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (etxUsd === null || !Number.isFinite(etxUsd)) return `${human} ETX`;
  const usd = etx * etxUsd;
  if (usd === 0) return `${human} ETX  ($0.00)`;
  if (usd >= 0.01) return `${human} ETX  ($${usd.toFixed(2)})`;
  return `${human} ETX  ($${usd.toFixed(4)})`;
}

function fmtCooldown(secs: number): string {
  if (secs <= 0) return 'ready';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${(secs / 3600).toFixed(1)}h`;
  return `${(secs / 86400).toFixed(1)}d`;
}

export function HarvestNowCard() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const onMainnet = chainId === eticaMainnet.id;

  const harvester = DEPLOYMENTS[eticaMainnet.id].treasuryHarvester as Address;
  const factory = DEPLOYMENTS[eticaMainnet.id].swapFactory as Address;
  const etx = DEPLOYMENTS[eticaMainnet.id].etx as Address;
  const wegaz = DEPLOYMENTS[eticaMainnet.id].wegaz as Address;

  const [ownerAddr, setOwnerAddr] = useState<Address | null>(null);
  const [cfg, setCfg] = useState<HarvesterCfg | null>(null);
  const [pools, setPools] = useState<PoolSnapshot[] | null>(null);
  const [etxUsd, setEtxUsd] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [tx, setTx] = useState<TxState>({ status: 'idle' });
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Heartbeat so the cooldown countdown updates without polling RPC.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Live ETX/USD for preview formatting.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/tickers')
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const etxRow = (j?.tickers ?? []).find((t: { base_currency?: string }) =>
          t?.base_currency?.toUpperCase?.() === 'ETX',
        );
        const last = Number(etxRow?.last_price);
        setEtxUsd(Number.isFinite(last) && last > 0 ? last : null);
      })
      .catch(() => setEtxUsd(null));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!publicClient || !onMainnet || harvester === ZERO_ADDRESS) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const [
          ownerRaw,
          maxBurnRaw,
          stakedBpsRaw,
          farmsBpsRaw,
          polBpsRaw,
          treasuryBpsRaw,
          cooldownRaw,
          lastRaw,
        ] = await Promise.all([
          publicClient.readContract({ address: harvester, abi: harvesterAbi, functionName: 'owner' }),
          publicClient.readContract({ address: harvester, abi: harvesterAbi, functionName: 'maxBurnBpsPerRun' }),
          publicClient.readContract({ address: harvester, abi: harvesterAbi, functionName: 'stakedEtxBps' }),
          publicClient.readContract({ address: harvester, abi: harvesterAbi, functionName: 'farmsBps' }),
          publicClient.readContract({ address: harvester, abi: harvesterAbi, functionName: 'polBurnBps' }),
          publicClient.readContract({ address: harvester, abi: harvesterAbi, functionName: 'treasuryBps' }),
          publicClient.readContract({ address: harvester, abi: harvesterAbi, functionName: 'harvestCooldown' }),
          publicClient.readContract({ address: harvester, abi: harvesterAbi, functionName: 'lastHarvestAt' }),
        ]);
        if (cancelled) return;
        const owner = ownerRaw as Address;
        setOwnerAddr(owner);
        setCfg({
          maxBurnBps: Number(maxBurnRaw),
          stakedBps: Number(stakedBpsRaw),
          farmsBps: Number(farmsBpsRaw),
          polBps: Number(polBpsRaw),
          treasuryBps: Number(treasuryBpsRaw),
          cooldown: Number(cooldownRaw),
          lastHarvestAt: lastRaw as bigint,
        });

        // Load POL pools (ETI/ETX, WEGAZ/ETX) — mirrors the keeper plan.
        const candidates: { label: string; nonEtx: Address }[] = [
          { label: 'ETI/ETX', nonEtx: ETI_ADDRESS },
          { label: 'WEGAZ/ETX', nonEtx: wegaz },
        ];
        const snapshots: PoolSnapshot[] = [];
        for (const c of candidates) {
          const pair = (await publicClient.readContract({
            address: factory,
            abi: factoryAbi,
            functionName: 'getPair',
            args: [etx, c.nonEtx],
          })) as Address;
          if (pair === ZERO_ADDRESS) continue;
          const [token0, reserves, totalSupply, treasuryLp] = await Promise.all([
            publicClient.readContract({ address: pair, abi: pairAbi, functionName: 'token0' }),
            publicClient.readContract({ address: pair, abi: pairAbi, functionName: 'getReserves' }),
            publicClient.readContract({ address: pair, abi: pairAbi, functionName: 'totalSupply' }),
            publicClient.readContract({ address: pair, abi: pairAbi, functionName: 'balanceOf', args: [owner] }),
          ]);
          const [r0, r1] = reserves as readonly [bigint, bigint, number];
          const etxIsToken0 = (token0 as Address).toLowerCase() === etx.toLowerCase();
          snapshots.push({
            label: c.label,
            pair,
            nonEtx: c.nonEtx,
            reserveEtx: etxIsToken0 ? r0 : r1,
            reserveNonEtx: etxIsToken0 ? r1 : r0,
            totalSupply: totalSupply as bigint,
            treasuryLp: treasuryLp as bigint,
          });
        }
        if (cancelled) return;
        setPools(snapshots);
      } catch (e) {
        if (!cancelled) setLoadError(shortError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, onMainnet, harvester, factory, etx, wegaz, reloadTick]);

  const plan = useMemo(() => {
    if (!cfg || !pools || pools.length === 0) return null;

    // 1. Per-pool LP burn + expected ETX from burn + non-ETX → ETX swap.
    const perPool = pools.map((p) => {
      if (p.treasuryLp === 0n || p.totalSupply === 0n) {
        return {
          pool: p,
          lpToBurn: 0n,
          expectedEtxFromBurn: 0n,
          expectedNonEtxFromBurn: 0n,
          expectedEtxFromSwap: 0n,
        };
      }
      const lpToBurn = (p.treasuryLp * BigInt(cfg.maxBurnBps)) / 10_000n;
      const etxOut = lpToBurn === 0n ? 0n : (lpToBurn * p.reserveEtx) / p.totalSupply;
      const nonOut = lpToBurn === 0n ? 0n : (lpToBurn * p.reserveNonEtx) / p.totalSupply;
      const resE1 = p.reserveEtx - etxOut;
      const resN1 = p.reserveNonEtx - nonOut;
      const etxSwap = estimateSwapOut(nonOut, resN1, resE1);
      return {
        pool: p,
        lpToBurn,
        expectedEtxFromBurn: etxOut,
        expectedNonEtxFromBurn: nonOut,
        expectedEtxFromSwap: etxSwap,
      };
    });

    const expectedEtxHarvested = perPool.reduce(
      (acc, x) => acc + x.expectedEtxFromBurn + x.expectedEtxFromSwap,
      0n,
    );

    const stakedSlice = (expectedEtxHarvested * BigInt(cfg.stakedBps)) / 10_000n;
    const farmsSlice = (expectedEtxHarvested * BigInt(cfg.farmsBps)) / 10_000n;
    const polSlice = (expectedEtxHarvested * BigInt(cfg.polBps)) / 10_000n;
    const treasurySlice = expectedEtxHarvested - stakedSlice - farmsSlice - polSlice;

    // 2. POL distribution by treasury_lp ETX-weight (same as keeper).
    const weights = pools.map((p) =>
      p.totalSupply === 0n || p.treasuryLp === 0n
        ? 0n
        : (p.reserveEtx * p.treasuryLp) / p.totalSupply,
    );
    const totalWeight = weights.reduce((a, b) => a + b, 0n);
    const polAllocs: bigint[] = [];
    if (polSlice === 0n || totalWeight === 0n) {
      polAllocs.push(...pools.map(() => 0n));
    } else {
      let acc = 0n;
      for (let i = 0; i < pools.length; i++) {
        if (i === pools.length - 1) {
          polAllocs.push(polSlice - acc);
        } else {
          const share = (polSlice * weights[i]!) / totalWeight;
          polAllocs.push(share);
          acc += share;
        }
      }
    }

    // 3. Build the on-chain PoolPlan[] tuple array.
    const onchainPools: PoolPlan[] = perPool.map((entry, i) => {
      const polTotal = polAllocs[i] ?? 0n;
      let polForSwap = polTotal / 2n;
      let polForPair = polTotal - polForSwap;
      // Estimate non-ETX received from POL ETX → non-ETX swap, against
      // post-burn-and-swap reserves. The ETX side has been reduced by
      // (etxFromBurn + etxFromSwap); the non-ETX side is restored by the
      // swap-to-ETX step (it pulls etxFromSwap out and pushes nonOut in).
      const resE = entry.pool.reserveEtx - entry.expectedEtxFromBurn - entry.expectedEtxFromSwap;
      const resN = entry.pool.reserveNonEtx;
      let nonFromPolSwap = estimateSwapOut(polForSwap, resE, resN);
      // Contract enforces (polEtxForSwap == 0) == (polEtxForPair == 0).
      // If either rounds to zero, zero out both legs.
      if (polForSwap === 0n || polForPair === 0n || nonFromPolSwap === 0n) {
        polForSwap = 0n;
        polForPair = 0n;
        nonFromPolSwap = 0n;
      }
      return {
        pair: entry.pool.pair,
        nonEtx: entry.pool.nonEtx,
        lpToBurn: entry.lpToBurn,
        minEtxFromBurn: withSlippage(entry.expectedEtxFromBurn, DEFAULT_SLIPPAGE_BPS),
        minNonEtxFromBurn: withSlippage(entry.expectedNonEtxFromBurn, DEFAULT_SLIPPAGE_BPS),
        minEtxFromSwap: withSlippage(entry.expectedEtxFromSwap, DEFAULT_SLIPPAGE_BPS),
        polEtxForSwap: polForSwap,
        polEtxForPair: polForPair,
        minNonEtxFromPolSwap: withSlippage(nonFromPolSwap, DEFAULT_SLIPPAGE_BPS),
      };
    });

    const totalPolAssigned = onchainPools.reduce(
      (acc, p) => acc + p.polEtxForSwap + p.polEtxForPair,
      0n,
    );

    return {
      perPool,
      onchainPools,
      expectedEtxHarvested,
      stakedSlice,
      farmsSlice,
      polSlice,
      treasurySlice,
      totalPolAssigned,
    };
  }, [cfg, pools]);

  const cooldownReadyAt =
    cfg && cfg.lastHarvestAt > 0n ? Number(cfg.lastHarvestAt) + cfg.cooldown : 0;
  const cooldownRemaining = Math.max(0, cooldownReadyAt - now);
  const onCooldown = cooldownRemaining > 0;

  const empty = !plan || plan.expectedEtxHarvested === 0n;
  const ready = !!cfg && !!plan && !empty && !onCooldown && onMainnet && isConnected;

  async function handleHarvest() {
    if (!walletClient || !publicClient || !plan || !cfg) return;
    setTx({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: harvester,
        abi: harvesterAbi,
        functionName: 'harvest',
        args: [plan.onchainPools],
      });
      setTx({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'success') {
        setTx({ status: 'confirmed', txHash: hash });
        setReloadTick((t) => t + 1);
      } else {
        setTx({ status: 'error', txHash: hash, error: 'Reverted on chain.' });
      }
    } catch (e) {
      setTx({ status: 'error', error: shortError(e) });
    }
  }

  if (harvester === ZERO_ADDRESS) {
    return (
      <section className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-2 text-lg font-semibold">Harvest now</h2>
        <p className="text-sm text-amber-300/80">
          TreasuryHarvester address is unset. Deploy via{' '}
          <a href="/deploy/harvester" className="underline">
            /deploy/harvester
          </a>
          .
        </p>
      </section>
    );
  }

  return (
    <section className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-5">
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Harvest now</h2>
        <span className="text-xs text-white/50">
          {onCooldown ? `cooldown: ${fmtCooldown(cooldownRemaining)}` : 'ready'}
        </span>
      </header>

      <p className="mb-4 text-sm text-white/60">
        Permissionless: any wallet can call <span className="font-mono">harvest()</span>; the
        treasury wallet is the natural caller because it pays gas. Plan is built client-side
        from current on-chain state and mirrors the keeper&apos;s cron-mode plan exactly.
      </p>

      {loading && <p className="text-sm text-white/50">Loading on-chain state…</p>}
      {loadError && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{loadError}</p>
      )}

      {plan && cfg && (
        <>
          <dl className="mb-4 grid grid-cols-1 gap-y-1 text-sm sm:grid-cols-2">
            <dt className="text-white/50">Burn cap</dt>
            <dd className="font-mono">{cfg.maxBurnBps} bps of treasury LP per pool</dd>
            <dt className="text-white/50">Splits (staked / farms / POL / treasury)</dt>
            <dd className="font-mono">
              {cfg.stakedBps} / {cfg.farmsBps} / {cfg.polBps} / {cfg.treasuryBps} bps
            </dd>
            <dt className="text-white/50">Cooldown</dt>
            <dd className="font-mono">
              {cfg.cooldown}s ({fmtCooldown(cfg.cooldown)})
            </dd>
            <dt className="text-white/50">Last harvest</dt>
            <dd className="font-mono">
              {cfg.lastHarvestAt === 0n
                ? 'never (first run)'
                : new Date(Number(cfg.lastHarvestAt) * 1000).toISOString().replace('T', ' ').slice(0, 19) +
                  ' UTC'}
            </dd>
          </dl>

          <div className="mb-4 overflow-x-auto rounded-lg border border-white/10">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-white/5 text-white/50">
                <tr>
                  <th className="px-3 py-2">Pool</th>
                  <th className="px-3 py-2">LP to burn</th>
                  <th className="px-3 py-2">ETX from burn + swap</th>
                  <th className="px-3 py-2">POL ETX</th>
                </tr>
              </thead>
              <tbody>
                {plan.perPool.map((entry, i) => (
                  <tr key={entry.pool.pair} className="border-t border-white/5">
                    <td className="px-3 py-2 font-mono">{entry.pool.label}</td>
                    <td className="px-3 py-2 font-mono">
                      {(Number(entry.lpToBurn) / 1e18).toFixed(6)}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {fmtEtx(entry.expectedEtxFromBurn + entry.expectedEtxFromSwap, etxUsd)}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {fmtEtx(
                        plan.onchainPools[i]!.polEtxForSwap + plan.onchainPools[i]!.polEtxForPair,
                        etxUsd,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="mb-4 grid grid-cols-1 gap-y-1 text-sm sm:grid-cols-2">
            <dt className="text-white/50">Expected ETX harvested</dt>
            <dd className="font-mono">{fmtEtx(plan.expectedEtxHarvested, etxUsd)}</dd>
            <dt className="text-white/50">→ stETX vault</dt>
            <dd className="font-mono">{fmtEtx(plan.stakedSlice, etxUsd)}</dd>
            <dt className="text-white/50">→ ETXFarms</dt>
            <dd className="font-mono">{fmtEtx(plan.farmsSlice, etxUsd)}</dd>
            <dt className="text-white/50">→ POL burn (LP to 0xdead)</dt>
            <dd className="font-mono">{fmtEtx(plan.polSlice, etxUsd)}</dd>
            <dt className="text-white/50">→ Treasury</dt>
            <dd className="font-mono">{fmtEtx(plan.treasurySlice, etxUsd)}</dd>
          </dl>
        </>
      )}

      {!isConnected && (
        <p className="mb-2 text-xs text-amber-300/80">Connect a wallet to call harvest().</p>
      )}
      {isConnected && !onMainnet && (
        <p className="mb-2 text-xs text-amber-300/80">
          Switch to Etica Mainnet (chain {eticaMainnet.id}) to call harvest().
        </p>
      )}
      {ownerAddr && (
        <p className="mb-3 text-xs text-white/50">
          Note: <span className="font-mono">harvest()</span> is permissionless. The owner address (
          <span className="font-mono">
            {ownerAddr.slice(0, 6)}…{ownerAddr.slice(-4)}
          </span>
          ) is only used to read treasury LP balances — any wallet can submit the call.
        </p>
      )}
      {!loading && !loadError && empty && (
        <p className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Nothing to harvest right now: treasury LP is zero or the burn slice rounded to zero on
          all pools.
        </p>
      )}

      <button
        type="button"
        onClick={handleHarvest}
        disabled={!ready || tx.status === 'signing' || tx.status === 'pending'}
        className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-black hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/30"
      >
        {tx.status === 'signing' && 'Confirm in wallet…'}
        {tx.status === 'pending' && 'Pending…'}
        {tx.status !== 'signing' && tx.status !== 'pending' && 'Harvest now'}
      </button>

      {tx.status === 'error' && tx.error && (
        <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{tx.error}</p>
      )}
      {tx.status === 'pending' && tx.txHash && (
        <p className="mt-3 text-xs text-white/60">
          Pending:{' '}
          <a
            href={`https://eticascan.org/tx/${tx.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-emerald-400 hover:underline"
          >
            {tx.txHash.slice(0, 10)}…{tx.txHash.slice(-6)}
          </a>
        </p>
      )}
      {tx.status === 'confirmed' && tx.txHash && (
        <p className="mt-3 text-xs text-emerald-400">
          Confirmed:{' '}
          <a
            href={`https://eticascan.org/tx/${tx.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono hover:underline"
          >
            {tx.txHash.slice(0, 10)}…{tx.txHash.slice(-6)}
          </a>
        </p>
      )}
    </section>
  );
}
