'use client';

import { useEffect, useState } from 'react';
import { BaseError, UserRejectedRequestError, type Address, type Hex } from 'viem';
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { abis, DEPLOYMENTS } from '@etica-hub/shared';
import { eticaMainnet } from '@etica-hub/shared/chains';

const farmsAbi = abis.etxFarmsAbi;
const factoryAbi = abis.factoryAbi;

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

type TxState = {
  status: 'idle' | 'signing' | 'pending' | 'confirmed' | 'error';
  txHash?: Hex;
  error?: string;
};

const initial: TxState = { status: 'idle' };

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

function ShortAddr({ value }: { value: Address | undefined | null }) {
  if (!value) return <span className="font-mono text-white/40">—</span>;
  if (value === ZERO_ADDRESS) return <span className="font-mono text-amber-300">0x0 (unset)</span>;
  return (
    <a
      href={`https://eticascan.org/address/${value}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-emerald-400 hover:underline"
    >
      {value}
    </a>
  );
}

function TxLink({ hash }: { hash: Hex | undefined }) {
  if (!hash) return null;
  return (
    <a
      href={`https://eticascan.org/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-emerald-400 hover:underline"
    >
      {hash.slice(0, 10)}…{hash.slice(-6)}
    </a>
  );
}

function StateBadge({ state }: { state: TxState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'error' && state.error) {
    return (
      <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
        {state.error}
        {state.txHash && (
          <>
            {' · '}
            <TxLink hash={state.txHash} />
          </>
        )}
      </div>
    );
  }
  return (
    <div className="mt-3 text-xs text-white/60">
      {state.status === 'signing' && 'Confirm in wallet…'}
      {state.status === 'pending' && (
        <>
          Pending: <TxLink hash={state.txHash} />
        </>
      )}
      {state.status === 'confirmed' && (
        <span className="text-emerald-400">
          Confirmed: <TxLink hash={state.txHash} />
        </span>
      )}
    </div>
  );
}

type PoolRow = {
  label: string;
  nonEtx: Address;
  allocPoint: number;
  /** Resolved on-chain LP pair address. */
  lpToken: Address | null;
  /** Existing pid if already added, else null. */
  existingPid: number | null;
};

export function AdminFarmsCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const farms = DEPLOYMENTS[eticaMainnet.id].etxFarms as Address;
  const factory = DEPLOYMENTS[eticaMainnet.id].swapFactory as Address;
  const etx = DEPLOYMENTS[eticaMainnet.id].etx as Address;
  const stakedEtx = DEPLOYMENTS[eticaMainnet.id].stakedETX as Address;
  const wegaz = DEPLOYMENTS[eticaMainnet.id].wegaz as Address;
  const eti = '0x34c61EA91bAcdA647269d4e310A86b875c09946f' as Address;

  const [owner, setOwner] = useState<Address | null>(null);
  const [poolLength, setPoolLength] = useState<number | null>(null);
  const [totalAllocPoint, setTotalAllocPoint] = useState<bigint | null>(null);
  const [pools, setPools] = useState<PoolRow[]>([
    { label: 'stETX/ETX', nonEtx: stakedEtx, allocPoint: 6000, lpToken: null, existingPid: null },
    { label: 'EGAZ/ETX', nonEtx: wegaz, allocPoint: 2500, lpToken: null, existingPid: null },
    { label: 'ETI/ETX', nonEtx: eti, allocPoint: 1500, lpToken: null, existingPid: null },
  ]);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!publicClient || !onMainnet || farms === ZERO_ADDRESS) return;
    let cancelled = false;
    (async () => {
      try {
        const [ownerRaw, lenRaw, totalRaw] = await Promise.all([
          publicClient.readContract({
            address: farms,
            abi: farmsAbi,
            functionName: 'owner',
          }),
          publicClient.readContract({
            address: farms,
            abi: farmsAbi,
            functionName: 'poolLength',
          }),
          publicClient.readContract({
            address: farms,
            abi: farmsAbi,
            functionName: 'totalAllocPoint',
          }),
        ]);
        if (cancelled) return;
        setOwner(ownerRaw as Address);
        const len = Number(lenRaw as bigint);
        setPoolLength(len);
        setTotalAllocPoint(totalRaw as bigint);

        const resolvedLp = await Promise.all(
          pools.map(
            (row) =>
              publicClient.readContract({
                address: factory,
                abi: factoryAbi,
                functionName: 'getPair',
                args: [row.nonEtx, etx],
              }) as Promise<Address>,
          ),
        );
        const existingLpTokens = new Map<string, number>();
        for (let pid = 0; pid < len; pid++) {
          const info = (await publicClient.readContract({
            address: farms,
            abi: farmsAbi,
            functionName: 'poolInfo',
            args: [BigInt(pid)],
          })) as readonly [Address, bigint, bigint, bigint];
          existingLpTokens.set(info[0].toLowerCase(), pid);
        }
        if (cancelled) return;
        setPools((prev) =>
          prev.map((row, i) => {
            const lp = resolvedLp[i]!;
            const existingPid = existingLpTokens.get(lp.toLowerCase()) ?? null;
            return { ...row, lpToken: lp, existingPid };
          }),
        );
      } catch {
        // leave nulls
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, onMainnet, farms, factory, etx, reloadTick]);

  const isAuthorized =
    isConnected &&
    onMainnet &&
    !!address &&
    !!owner &&
    address.toLowerCase() === owner.toLowerCase();

  const [addPoolStates, setAddPoolStates] = useState<TxState[]>([initial, initial, initial]);
  async function doAddPool(idx: number) {
    const row = pools[idx];
    if (
      !walletClient ||
      !publicClient ||
      !isAuthorized ||
      !row?.lpToken ||
      row.lpToken === ZERO_ADDRESS ||
      row.existingPid !== null
    )
      return;
    setAddPoolStates((s) => s.map((v, i) => (i === idx ? { status: 'signing' } : v)));
    try {
      const hash = await walletClient.writeContract({
        address: farms,
        abi: farmsAbi,
        functionName: 'addPool',
        args: [row.lpToken, BigInt(row.allocPoint)],
      });
      setAddPoolStates((s) =>
        s.map((v, i) => (i === idx ? { status: 'pending', txHash: hash } : v)),
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setAddPoolStates((s) =>
          s.map((v, i) =>
            i === idx ? { status: 'error', txHash: hash, error: 'Reverted on-chain' } : v,
          ),
        );
      } else {
        setAddPoolStates((s) =>
          s.map((v, i) => (i === idx ? { status: 'confirmed', txHash: hash } : v)),
        );
        setReloadTick((x) => x + 1);
      }
    } catch (err) {
      setAddPoolStates((s) =>
        s.map((v, i) => (i === idx ? { status: 'error', error: shortError(err) } : v)),
      );
    }
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];

  return (
    <div className="space-y-6">
      {/* Wallet */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Wallet</h2>
        {!isConnected && (
          <button
            onClick={() => injectedConnector && connect({ connector: injectedConnector })}
            disabled={!injectedConnector || connectStatus === 'pending'}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
          >
            {connectStatus === 'pending' ? 'Connecting…' : 'Connect MetaMask'}
          </button>
        )}
        {isConnected && (
          <div className="space-y-3 text-sm">
            <div className="font-mono break-all text-white/80">{address}</div>
            <div>
              Chain:{' '}
              <span className={onMainnet ? 'text-emerald-400' : 'text-amber-400'}>
                {onMainnet ? 'Etica Mainnet (61803)' : `Wrong network (${chainId})`}
              </span>
            </div>
            {!onMainnet && (
              <button
                onClick={() => switchChain({ chainId: eticaMainnet.id })}
                disabled={switching}
                className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400 disabled:opacity-50"
              >
                {switching ? 'Switching…' : 'Switch to Etica Mainnet'}
              </button>
            )}
            <button
              onClick={() => disconnect()}
              className="ml-2 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-medium text-white/70 hover:bg-white/10"
            >
              Disconnect
            </button>
            {onMainnet && owner && !isAuthorized && (
              <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                Connected wallet is not the farms <span className="font-mono">owner</span>. All
                write buttons are disabled. Expected: <span className="font-mono">{owner}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Current state */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5 text-sm">
        <h2 className="mb-3 text-lg font-semibold">Current farms state</h2>
        {farms === ZERO_ADDRESS ? (
          <p className="text-amber-300">
            ETXFarms address is zero in <span className="font-mono">addresses.ts</span>.
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-y-2 md:grid-cols-[200px_1fr] md:gap-x-4">
            <dt className="text-white/50">ETXFarms</dt>
            <dd>
              <ShortAddr value={farms} />
            </dd>
            <dt className="text-white/50">owner()</dt>
            <dd>
              <ShortAddr value={owner} />
            </dd>
            <dt className="text-white/50">poolLength()</dt>
            <dd className="font-mono">{poolLength === null ? '—' : poolLength}</dd>
            <dt className="text-white/50">totalAllocPoint()</dt>
            <dd className="font-mono">
              {totalAllocPoint === null ? '—' : totalAllocPoint.toString()}
            </dd>
          </dl>
        )}
        <button
          onClick={() => setReloadTick((x) => x + 1)}
          className="mt-3 rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
        >
          Refresh
        </button>
      </section>

      {/* addPool */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-2 text-lg font-semibold">Register launch pools (addPool × 3)</h2>
        <p className="mb-4 text-sm text-white/60">
          Register the three LP pairs with weighted emissions. <strong>60 / 25 / 15</strong> split
          funnels 60% of farm rewards to stETX/ETX (liquidity for the staking vault), 25% to
          EGAZ/ETX (gas on-ramp), and 15% to ETI/ETX (parent-chain pair). After all three land,{' '}
          <span className="font-mono">totalAllocPoint</span> will be <strong>10000</strong>.
        </p>
        <div className="space-y-3">
          {pools.map((row, i) => {
            const alreadyAdded = row.existingPid !== null;
            return (
              <div key={row.label} className="rounded-lg border border-white/10 bg-black/20 p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <div>
                    <span className="font-medium">{row.label} LP</span>{' '}
                    <span className="text-xs text-white/50">
                      · weight {row.allocPoint} ({((row.allocPoint / 10000) * 100).toFixed(0)}%)
                    </span>
                  </div>
                  <div className="text-xs">
                    LP: <ShortAddr value={row.lpToken} />
                  </div>
                </div>
                <div className="mb-3 text-xs text-white/60">
                  status:{' '}
                  {alreadyAdded ? (
                    <span className="text-emerald-400">
                      already registered as pid {row.existingPid}
                    </span>
                  ) : (
                    <span className="text-amber-300">not registered</span>
                  )}
                </div>
                <button
                  onClick={() => doAddPool(i)}
                  disabled={
                    !isAuthorized ||
                    !row.lpToken ||
                    row.lpToken === ZERO_ADDRESS ||
                    alreadyAdded ||
                    addPoolStates[i]?.status === 'signing' ||
                    addPoolStates[i]?.status === 'pending'
                  }
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
                >
                  {alreadyAdded ? 'Already added' : `addPool(${row.label}, ${row.allocPoint})`}
                </button>
                <StateBadge state={addPoolStates[i] ?? initial} />
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
