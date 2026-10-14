'use client';

/**
 * Opens and seeds extra EticaSwap Direct windows on the live factory.
 *
 * Any two non-ETX tokens that both have a hub pool can be a window. Admin
 * steps go through whoever is `feeToSetter`: a plain tx when the connected
 * wallet is the setter itself, otherwise propose / confirm on the 2-of-2
 * (the second signer opens the same page and clicks once; that executes).
 *
 * Seeding uses the metapair's loose-ETX path: the whitelisted seeder sends
 * ETX to the window and calls `mint(DEAD)`; the window buys both legs
 * half/half on the hub and locks them as hub LP. No stETX or USDC.e needed.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  encodeFunctionData,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWriteContract,
} from 'wagmi';
import { eticaMainnet } from '@etica-hub/shared/chains';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  USDC_WARP_ROUTE,
  abis,
  isSupportedChainId,
} from '@etica-hub/shared';
import {
  directFactoryArtifact,
  directMetaPairArtifact,
  unanimousMultisigArtifact,
} from '@/lib/direct-deploy-artifacts';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const DEAD: Address = '0x000000000000000000000000000000000000dEaD';
const SEED_USD_PER_WINDOW = 20; // ~$10 per leg, bought on the hub from ETX

type Role = 'admin' | 'seeder';
type Sym = 'EGAZ' | 'ETI' | 'stETX' | 'USDC.e';
type Ctx = {
  factory: Address;
  hubRouter: Address;
  hubFactory: Address;
  etx: Address;
  tokens: Record<Sym, Address>;
};
type Spec = { a: Sym; b: Sym };

const SPECS: Spec[] = [
  { a: 'EGAZ', b: 'ETI' },
  { a: 'stETX', b: 'USDC.e' },
  { a: 'stETX', b: 'EGAZ' },
  { a: 'stETX', b: 'ETI' },
];

type Status = 'idle' | 'signing' | 'pending' | 'confirmed' | 'error';
type Step = { status: Status; txHash?: Hex; error?: string };

function useCtx(): Ctx | null {
  const chainId = useChainId();
  return useMemo(() => {
    if (!isSupportedChainId(chainId)) return null;
    const d = DEPLOYMENTS[chainId];
    const e = EXTERNAL_ADDRESSES[chainId];
    if (d.directFactory === ZERO) return null;
    return {
      factory: d.directFactory,
      hubRouter: d.swapRouter,
      hubFactory: d.swapFactory,
      etx: d.etx,
      tokens: {
        EGAZ: d.wegaz,
        ETI: e.eti,
        stETX: d.stakedETX,
        'USDC.e': USDC_WARP_ROUTE.syntheticToken,
      },
    };
  }, [chainId]);
}

function shortError(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return 'Rejected in wallet';
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : 'Failed';
}

const same = (a?: Address | null, b?: Address | null) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

const fmt = (n: bigint, d = 18, f = 2) => {
  const [i, r = ''] = formatUnits(n, d).split('.');
  const frac = r.slice(0, f).replace(/0+$/, '');
  return frac ? `${i}.${frac}` : i;
};

export function DirectWindowsCard({ role }: { role: Role }) {
  const ctx = useCtx();
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const dappChainId = useChainId();
  const publicClient = usePublicClient();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const onMainnet = isConnected && walletChainId === dappChainId && dappChainId === eticaMainnet.id;

  const factoryAbi = directFactoryArtifact.abi;
  const metaPairAbi = directMetaPairArtifact.abi;
  const msAbi = unanimousMultisigArtifact.abi;

  const [steps, setSteps] = useState<Record<string, Step>>({});
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);

  // ---- factory state
  const setter = useReadContract({
    abi: factoryAbi,
    address: ctx?.factory,
    functionName: 'feeToSetter',
    query: { enabled: Boolean(ctx) },
  });
  const setterAddr = setter.data as Address | undefined;
  const whitelisted = useReadContract({
    abi: factoryAbi,
    address: ctx?.factory,
    functionName: 'whitelist',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(ctx && address) },
  });
  const pairReads = useReadContracts({
    contracts: SPECS.map((s) => ({
      abi: factoryAbi,
      address: ctx?.factory ?? ZERO,
      functionName: 'getPair' as const,
      args: [ctx?.tokens[s.a] ?? ZERO, ctx?.tokens[s.b] ?? ZERO],
    })),
    query: { enabled: Boolean(ctx) },
  });
  const windows = useMemo<(Address | null)[]>(
    () =>
      SPECS.map((_, i) => {
        const r = pairReads.data?.[i];
        const a = r?.status === 'success' ? (r.result as Address) : ZERO;
        return a === ZERO ? null : a;
      }),
    [pairReads.data],
  );
  // Backing per window = hub LP it holds on either leg (0 ⇒ unseeded).
  const backing = useReadContracts({
    contracts: windows
      .filter((w): w is Address => Boolean(w))
      .map((w) => ({ abi: metaPairAbi, address: w, functionName: 'totalSupply' as const })),
    query: { enabled: windows.some(Boolean) },
  });
  const seededByWindow = useMemo(() => {
    const m = new Map<Address, boolean>();
    let j = 0;
    for (const w of windows) {
      if (!w) continue;
      const r = backing.data?.[j++];
      m.set(w, r?.status === 'success' && (r.result as bigint) > 0n);
    }
    return m;
  }, [windows, backing.data]);

  // ---- ETX seed amount from the USDC.e/ETX hub pool
  const usdcPair = useReadContract({
    abi: abis.factoryAbi,
    address: ctx?.hubFactory,
    functionName: 'getPair',
    args: ctx ? [ctx.tokens['USDC.e'], ctx.etx] : undefined,
    query: { enabled: Boolean(ctx) },
  });
  const usdcPairAddr = usdcPair.data as Address | undefined;
  const usdcReserves = useReadContracts({
    contracts: [
      { abi: abis.pairAbi, address: usdcPairAddr ?? ZERO, functionName: 'getReserves' as const },
      { abi: abis.pairAbi, address: usdcPairAddr ?? ZERO, functionName: 'token0' as const },
    ],
    query: { enabled: Boolean(usdcPairAddr && usdcPairAddr !== ZERO) },
  });
  const etxPerWindow = useMemo(() => {
    const r = usdcReserves.data;
    if (!ctx || !r || r[0].status !== 'success' || r[1].status !== 'success') return null;
    const [r0, r1] = r[0].result as readonly [bigint, bigint, number];
    const usdcIs0 = same(r[1].result as Address, ctx.tokens['USDC.e']);
    const [rUsdc, rEtx] = usdcIs0 ? [r0, r1] : [r1, r0];
    if (rUsdc === 0n) return null;
    const usd = parseUnits(String(SEED_USD_PER_WINDOW), USDC_WARP_ROUTE.decimals);
    return (usd * rEtx) / rUsdc;
  }, [usdcReserves.data, ctx]);
  const etxBal = useReadContract({
    abi: abis.erc20Abi,
    address: ctx?.etx,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(ctx && address) },
  });

  // ---- multisig proposals matching each createMetaPair
  const isMultisigSetter = Boolean(setterAddr && address && !same(setterAddr, address));
  const [proposals, setProposals] = useState<Record<number, { id: bigint; mine: boolean } | null>>({});
  useEffect(() => {
    if (!publicClient || !ctx || !setterAddr || !address || role !== 'admin' || !isMultisigSetter) return;
    let cancelled = false;
    (async () => {
      try {
        const count = (await publicClient.readContract({
          address: setterAddr,
          abi: msAbi,
          functionName: 'proposalCount',
        })) as bigint;
        const wanted = SPECS.map((s) =>
          encodeFunctionData({
            abi: factoryAbi,
            functionName: 'createMetaPair',
            args: [ctx.tokens[s.a], ctx.tokens[s.b], ctx.hubRouter],
          }).toLowerCase(),
        );
        const found: Record<number, { id: bigint; mine: boolean } | null> = {};
        for (let i = count; i > 0n && Object.keys(found).length < SPECS.length; i--) {
          const id = i - 1n;
          const p = (await publicClient.readContract({
            address: setterAddr,
            abi: msAbi,
            functionName: 'proposal',
            args: [id],
          })) as { target: Address; data: Hex; executed: boolean; cancelled: boolean };
          if (p.executed || p.cancelled || !same(p.target, ctx.factory)) continue;
          const idx = wanted.indexOf(p.data.toLowerCase());
          if (idx < 0 || found[idx]) continue;
          const mine = (await publicClient.readContract({
            address: setterAddr,
            abi: msAbi,
            functionName: 'confirmed',
            args: [id, address],
          })) as boolean;
          found[idx] = { id, mine };
        }
        if (!cancelled) setProposals(found);
      } catch {
        if (!cancelled) setProposals({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, ctx, setterAddr, address, role, isMultisigSetter, msAbi, factoryAbi, tick]);

  async function send(key: string, fn: () => Promise<Hex>): Promise<boolean> {
    if (!publicClient) return false;
    setSteps((s) => ({ ...s, [key]: { status: 'signing' } }));
    let hash: Hex;
    try {
      hash = await fn();
    } catch (err) {
      setSteps((s) => ({ ...s, [key]: { status: 'error', error: shortError(err) } }));
      return false;
    }
    setSteps((s) => ({ ...s, [key]: { status: 'pending', txHash: hash } }));
    try {
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      const ok = rc.status === 'success';
      setSteps((s) => ({
        ...s,
        [key]: ok
          ? { status: 'confirmed', txHash: hash }
          : { status: 'error', txHash: hash, error: 'Transaction reverted on-chain' },
      }));
      return ok;
    } catch (err) {
      setSteps((s) => ({ ...s, [key]: { status: 'error', txHash: hash, error: shortError(err) } }));
      return false;
    }
  }

  async function openWindow(i: number): Promise<boolean> {
    if (!ctx || !setterAddr || !address) return false;
    const s = SPECS[i];
    const key = `open-${i}`;
    const args = [ctx.tokens[s.a], ctx.tokens[s.b], ctx.hubRouter] as const;
    let ok: boolean;
    if (!isMultisigSetter) {
      ok = await send(key, () =>
        writeContractAsync({ abi: factoryAbi, address: ctx.factory, functionName: 'createMetaPair', args }),
      );
    } else {
      const p = proposals[i];
      if (p && p.mine) {
        setSteps((st) => ({
          ...st,
          [key]: {
            status: 'error',
            error: `Proposal #${p.id} is waiting for the other signer: they open this page and click once.`,
          },
        }));
        return false;
      }
      ok = p
        ? await send(key, () =>
            writeContractAsync({ abi: msAbi, address: setterAddr, functionName: 'confirm', args: [p.id] }),
          )
        : await send(key, () =>
            writeContractAsync({
              abi: msAbi,
              address: setterAddr,
              functionName: 'propose',
              args: [ctx.factory, 0n, encodeFunctionData({ abi: factoryAbi, functionName: 'createMetaPair', args })],
            }),
          );
    }
    await Promise.all([pairReads.refetch(), setter.refetch()]);
    setTick((t) => t + 1);
    return ok;
  }

  async function seedWindow(i: number): Promise<boolean> {
    const w = windows[i];
    if (!ctx || !w || !etxPerWindow) return false;
    const sent = await send(`send-${i}`, () =>
      writeContractAsync({ abi: abis.erc20Abi, address: ctx.etx, functionName: 'transfer', args: [w, etxPerWindow] }),
    );
    if (!sent) return false;
    const minted = await send(`mint-${i}`, () =>
      writeContractAsync({ abi: metaPairAbi, address: w, functionName: 'mint', args: [DEAD] }),
    );
    await Promise.all([backing.refetch(), etxBal.refetch()]);
    return minted;
  }

  const remaining = SPECS.map((_, i) => i).filter((i) =>
    role === 'admin' ? !windows[i] : Boolean(windows[i]) && !seededByWindow.get(windows[i]!),
  );
  const etxHave = (etxBal.data as bigint | undefined) ?? 0n;
  const etxNeed = etxPerWindow ? etxPerWindow * BigInt(remaining.length) : 0n;
  const isWhitelisted = whitelisted.data === true;
  const canRun =
    onMainnet && !running && remaining.length > 0 &&
    (role === 'admin' ? Boolean(setterAddr) : isWhitelisted && etxPerWindow !== null && etxHave >= etxNeed);

  async function runAll() {
    setRunning(true);
    try {
      for (const i of remaining) {
        const ok = role === 'admin' ? await openWindow(i) : await seedWindow(i);
        if (!ok) break;
      }
    } finally {
      setRunning(false);
    }
  }

  const windowsHref = ctx ? `https://eticahub.com/deploy/direct/windows/seed` : '#';

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/[0.07] bg-white/[0.035] p-5 text-sm text-white/70">
        <dl className="grid gap-2 sm:grid-cols-2">
          <div><dt className="text-xs text-white/40">Factory</dt><dd className="break-all font-mono text-xs">{ctx?.factory ?? '—'}</dd></div>
          <div><dt className="text-xs text-white/40">Admin (feeToSetter)</dt><dd className="break-all font-mono text-xs">{setterAddr ?? '—'}</dd></div>
          {role === 'seeder' && (
            <>
              <div><dt className="text-xs text-white/40">ETX per window (~${SEED_USD_PER_WINDOW})</dt><dd className="font-mono text-xs">{etxPerWindow ? fmt(etxPerWindow) : '—'}</dd></div>
              <div><dt className="text-xs text-white/40">ETX need / have</dt><dd className="font-mono text-xs">{fmt(etxNeed)} / {fmt(etxHave)}</dd></div>
            </>
          )}
        </dl>
        {!isConnected && <p className="mt-3 text-xs text-amber-300/80">Connect the {role === 'admin' ? 'treasury or second-signer' : 'seeder'} wallet.</p>}
        {isConnected && walletChainId !== eticaMainnet.id && (
          <button type="button" className="btn-tone mt-3 px-3 py-1.5 text-xs" onClick={() => switchChain({ chainId: eticaMainnet.id })} disabled={switching}>
            {switching ? 'Switching…' : 'Switch to Etica Mainnet'}
          </button>
        )}
        {role === 'seeder' && onMainnet && whitelisted.isFetched && !isWhitelisted && (
          <p className="mt-3 text-xs text-amber-300/80">This wallet is not on the factory whitelist; deposits would revert.</p>
        )}
        {role === 'admin' && isMultisigSetter && (
          <p className="mt-3 text-xs text-white/50">
            The factory belongs to the 2-of-2. Each window is one proposal: you click here, the other signer opens this page and clicks once, which executes it.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-white/[0.07] bg-white/[0.035] p-5">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{role === 'admin' ? 'Windows' : 'Seed'}</h2>
          <button type="button" className="ml-auto rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-semibold text-black transition hover:bg-emerald-400 disabled:opacity-30" onClick={() => void runAll()} disabled={!canRun}>
            {running
              ? 'Running… approve each popup'
              : remaining.length === 0
                ? 'All done'
                : role === 'admin'
                  ? `Open ${remaining.length} window${remaining.length > 1 ? 's' : ''} (${remaining.length} signatures)`
                  : `Seed ${remaining.length} window${remaining.length > 1 ? 's' : ''} (${remaining.length * 2} signatures)`}
          </button>
        </div>
        <ol className="space-y-3">
          {SPECS.map((s, i) => {
            const w = windows[i];
            const seeded = w ? seededByWindow.get(w) : false;
            const p = proposals[i];
            const st = steps[`open-${i}`] ?? steps[`mint-${i}`] ?? steps[`send-${i}`];
            const done = role === 'admin' ? Boolean(w) : Boolean(seeded);
            return (
              <li key={`${s.a}/${s.b}`} className={`rounded-md border p-3 ${done ? 'border-emerald-400/30 bg-emerald-500/5' : 'border-white/[0.07]'}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-xs text-white/40">{String(i + 1).padStart(2, '0')}</span>
                  <span className="text-sm font-medium">{s.a}/{s.b}</span>
                  <span className="text-xs text-white/40">
                    {w ? (seeded ? 'open · seeded' : 'open · not seeded') : p ? (p.mine ? `proposal #${p.id} awaiting the other signer` : `proposal #${p.id} awaiting your confirm`) : 'not open'}
                  </span>
                  {!done && (
                    <button type="button" className="ml-auto rounded-md bg-emerald-500/90 px-3 py-1 text-xs font-medium text-black transition hover:bg-emerald-400 disabled:opacity-30"
                      onClick={() => void (role === 'admin' ? openWindow(i) : seedWindow(i))}
                      disabled={!onMainnet || running || (role === 'seeder' && (!w || !isWhitelisted || !etxPerWindow)) || st?.status === 'signing' || st?.status === 'pending'}>
                      {st?.status === 'signing' ? 'Sign…' : st?.status === 'pending' ? 'Mining…' : role === 'admin' ? (p ? 'Confirm' : isMultisigSetter ? 'Propose' : 'Open') : 'Seed'}
                    </button>
                  )}
                </div>
                {w && <p className="mt-1 break-all font-mono text-[11px] text-white/35">{w}</p>}
                {st?.status === 'error' && <p className="mt-1 text-xs text-rose-300/90">{st.error}</p>}
              </li>
            );
          })}
        </ol>
        {role === 'admin' && (
          <p className="mt-4 text-xs text-white/50">
            Once a window is open, the seeder backs it from <Link href="/deploy/direct/windows/seed" className="text-emerald-300">{windowsHref}</Link>. The V5 tab on /swap, the watcher and the harvest cron pick new windows up from the factory by themselves.
          </p>
        )}
      </section>
    </div>
  );
}
