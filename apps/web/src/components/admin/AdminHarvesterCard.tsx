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

const harvesterAbi = abis.treasuryHarvesterAbi;
const factoryAbi = abis.factoryAbi;
const erc20Abi = abis.erc20Abi;

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;

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

function formatSeconds(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

type PairRow = {
  label: string;
  nonEtx: Address;
  pair: Address | null;
  allowance: bigint | null;
};

export function AdminHarvesterCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const harvester = DEPLOYMENTS[eticaMainnet.id].treasuryHarvester as Address;
  const factory = DEPLOYMENTS[eticaMainnet.id].swapFactory as Address;
  const etx = DEPLOYMENTS[eticaMainnet.id].etx as Address;
  const stakedEtx = DEPLOYMENTS[eticaMainnet.id].stakedETX as Address;
  const wegaz = DEPLOYMENTS[eticaMainnet.id].wegaz as Address;
  const farms = DEPLOYMENTS[eticaMainnet.id].etxFarms as Address;
  const eti = '0x34c61EA91bAcdA647269d4e310A86b875c09946f' as Address;

  const [owner, setOwner] = useState<Address | null>(null);
  const [onchainStakedEtx, setOnchainStakedEtx] = useState<Address | null>(null);
  const [onchainFarms, setOnchainFarms] = useState<Address | null>(null);
  const [cooldown, setCooldown] = useState<number | null>(null);
  const [maxBurnBps, setMaxBurnBps] = useState<number | null>(null);
  const [pairs, setPairs] = useState<PairRow[]>([
    { label: 'stETX/ETX LP', nonEtx: stakedEtx, pair: null, allowance: null },
    { label: 'EGAZ/ETX LP', nonEtx: wegaz, pair: null, allowance: null },
    { label: 'ETI/ETX LP', nonEtx: eti, pair: null, allowance: null },
  ]);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!publicClient || !onMainnet || harvester === ZERO_ADDRESS) return;
    let cancelled = false;
    (async () => {
      try {
        const [ownerRaw, stakedRaw, farmsRaw, cdRaw, maxRaw] = await Promise.all([
          publicClient.readContract({
            address: harvester,
            abi: harvesterAbi,
            functionName: 'owner',
          }),
          publicClient.readContract({
            address: harvester,
            abi: harvesterAbi,
            functionName: 'stakedEtx',
          }),
          publicClient.readContract({
            address: harvester,
            abi: harvesterAbi,
            functionName: 'farms',
          }),
          publicClient.readContract({
            address: harvester,
            abi: harvesterAbi,
            functionName: 'harvestCooldown',
          }),
          publicClient.readContract({
            address: harvester,
            abi: harvesterAbi,
            functionName: 'maxBurnBpsPerRun',
          }),
        ]);
        if (cancelled) return;
        const ownerAddr = ownerRaw as Address;
        setOwner(ownerAddr);
        setOnchainStakedEtx(stakedRaw as Address);
        setOnchainFarms(farmsRaw as Address);
        setCooldown(Number(cdRaw as number));
        setMaxBurnBps(Number(maxRaw as number));

        const resolved = await Promise.all(
          pairs.map(async (row) => {
            const pair = (await publicClient.readContract({
              address: factory,
              abi: factoryAbi,
              functionName: 'getPair',
              args: [row.nonEtx, etx],
            })) as Address;
            if (pair === ZERO_ADDRESS) {
              return { ...row, pair: ZERO_ADDRESS, allowance: 0n };
            }
            const allowance = (await publicClient.readContract({
              address: pair,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [ownerAddr, harvester],
            })) as bigint;
            return { ...row, pair, allowance };
          }),
        );
        if (cancelled) return;
        setPairs(resolved);
      } catch {
        // leave nulls
      }
    })();
    return () => {
      cancelled = true;
    };
    // pairs is mutable template; don't re-run when pairs changes (resolved updates set it)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, onMainnet, harvester, factory, etx, reloadTick]);

  const isAuthorized =
    isConnected &&
    onMainnet &&
    !!address &&
    !!owner &&
    address.toLowerCase() === owner.toLowerCase();

  // --- setStakedEtx ---
  const [setStakedState, setSetStakedState] = useState<TxState>(initial);
  async function doSetStakedEtx() {
    if (!walletClient || !publicClient || !isAuthorized) return;
    setSetStakedState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: harvester,
        abi: harvesterAbi,
        functionName: 'setStakedEtx',
        args: [stakedEtx],
      });
      setSetStakedState({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setSetStakedState({ status: 'error', txHash: hash, error: 'Reverted on-chain' });
      } else {
        setSetStakedState({ status: 'confirmed', txHash: hash });
        setReloadTick((x) => x + 1);
      }
    } catch (err) {
      setSetStakedState({ status: 'error', error: shortError(err) });
    }
  }

  // --- setFarms ---
  const [setFarmsState, setSetFarmsState] = useState<TxState>(initial);
  async function doSetFarms() {
    if (!walletClient || !publicClient || !isAuthorized) return;
    setSetFarmsState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: harvester,
        abi: harvesterAbi,
        functionName: 'setFarms',
        args: [farms],
      });
      setSetFarmsState({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setSetFarmsState({ status: 'error', txHash: hash, error: 'Reverted on-chain' });
      } else {
        setSetFarmsState({ status: 'confirmed', txHash: hash });
        setReloadTick((x) => x + 1);
      }
    } catch (err) {
      setSetFarmsState({ status: 'error', error: shortError(err) });
    }
  }

  // --- 3× LP approve ---
  const [approveStates, setApproveStates] = useState<TxState[]>([initial, initial, initial]);
  async function doApproveLp(idx: number) {
    const row = pairs[idx];
    if (!walletClient || !publicClient || !isAuthorized || !row?.pair || row.pair === ZERO_ADDRESS)
      return;
    setApproveStates((s) => s.map((v, i) => (i === idx ? { status: 'signing' } : v)));
    try {
      const hash = await walletClient.writeContract({
        address: row.pair,
        abi: erc20Abi,
        functionName: 'approve',
        args: [harvester, MAX_UINT256],
      });
      setApproveStates((s) =>
        s.map((v, i) => (i === idx ? { status: 'pending', txHash: hash } : v)),
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setApproveStates((s) =>
          s.map((v, i) =>
            i === idx ? { status: 'error', txHash: hash, error: 'Reverted on-chain' } : v,
          ),
        );
      } else {
        setApproveStates((s) =>
          s.map((v, i) => (i === idx ? { status: 'confirmed', txHash: hash } : v)),
        );
        setReloadTick((x) => x + 1);
      }
    } catch (err) {
      setApproveStates((s) =>
        s.map((v, i) => (i === idx ? { status: 'error', error: shortError(err) } : v)),
      );
    }
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];

  const stakedEtxSet = onchainStakedEtx && onchainStakedEtx !== ZERO_ADDRESS;
  const farmsSet = onchainFarms && onchainFarms !== ZERO_ADDRESS;

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
                Connected wallet is not the harvester <span className="font-mono">owner</span>. All
                write buttons are disabled. Expected: <span className="font-mono">{owner}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Current state */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5 text-sm">
        <h2 className="mb-3 text-lg font-semibold">Current harvester state</h2>
        {harvester === ZERO_ADDRESS ? (
          <p className="text-amber-300">
            TreasuryHarvester address is zero in <span className="font-mono">addresses.ts</span>.
            Deploy first via{' '}
            <a href="/deploy/harvester" className="underline">
              /deploy/harvester
            </a>{' '}
            and wire the address before using this page.
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-y-2 md:grid-cols-[200px_1fr] md:gap-x-4">
            <dt className="text-white/50">Harvester</dt>
            <dd>
              <ShortAddr value={harvester} />
            </dd>
            <dt className="text-white/50">owner()</dt>
            <dd>
              <ShortAddr value={owner} />
            </dd>
            <dt className="text-white/50">stakedEtx()</dt>
            <dd>
              <ShortAddr value={onchainStakedEtx} />
            </dd>
            <dt className="text-white/50">farms()</dt>
            <dd>
              <ShortAddr value={onchainFarms} />
            </dd>
            <dt className="text-white/50">harvestCooldown()</dt>
            <dd className="font-mono">
              {cooldown === null ? '—' : `${cooldown}s (${formatSeconds(cooldown)})`}
            </dd>
            <dt className="text-white/50">maxBurnBpsPerRun()</dt>
            <dd className="font-mono">
              {maxBurnBps === null ? '—' : `${maxBurnBps} bps (${maxBurnBps / 100}%)`}
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

      {/* setStakedEtx */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-2 text-lg font-semibold">1. setStakedEtx</h2>
        <p className="mb-3 text-sm text-white/60">
          Wires the <span className="font-mono">stETX</span> vault as the 10% staking slice target.
          Routes ETX into the ERC-4626 vault on every harvest; exchange rate per share climbs.
        </p>
        <div className="mb-3 grid grid-cols-1 gap-y-1 text-xs text-white/60 md:grid-cols-[120px_1fr]">
          <span>Target</span>
          <ShortAddr value={stakedEtx} />
          <span>Current</span>
          <ShortAddr value={onchainStakedEtx} />
        </div>
        <button
          onClick={doSetStakedEtx}
          disabled={
            !isAuthorized ||
            setStakedState.status === 'signing' ||
            setStakedState.status === 'pending' ||
            !!stakedEtxSet
          }
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
        >
          {stakedEtxSet ? 'Already set' : 'Call setStakedEtx'}
        </button>
        <StateBadge state={setStakedState} />
      </section>

      {/* setFarms */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-2 text-lg font-semibold">2. setFarms</h2>
        <p className="mb-3 text-sm text-white/60">
          Wires <span className="font-mono">ETXFarms</span> as the 10% farms slice target. The
          harvester calls <span className="font-mono">distributeRewards(amount)</span> so ETX is
          split pro-rata across staked LP pools.
        </p>
        <div className="mb-3 grid grid-cols-1 gap-y-1 text-xs text-white/60 md:grid-cols-[120px_1fr]">
          <span>Target</span>
          <ShortAddr value={farms} />
          <span>Current</span>
          <ShortAddr value={onchainFarms} />
        </div>
        <button
          onClick={doSetFarms}
          disabled={
            !isAuthorized ||
            setFarmsState.status === 'signing' ||
            setFarmsState.status === 'pending' ||
            !!farmsSet
          }
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
        >
          {farmsSet ? 'Already set' : 'Call setFarms'}
        </button>
        <StateBadge state={setFarmsState} />
      </section>

      {/* LP approvals */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-2 text-lg font-semibold">3. Approve harvester to pull LP</h2>
        <p className="mb-3 text-sm text-white/60">
          Each harvest burns a small slice of treasury LP. These approvals let the harvester call{' '}
          <span className="font-mono">transferFrom(owner, harvester, amount)</span> on each pair.
          Infinite allowance is safe: the on-chain{' '}
          <span className="font-mono">maxBurnBpsPerRun</span> = 1% caps per-call damage and the 23h
          cooldown caps frequency. Revoke at any time by approving 0.
        </p>
        <div className="space-y-3">
          {pairs.map((row, i) => {
            const already = row.allowance !== null && row.allowance > 0n;
            return (
              <div key={row.label} className="rounded-lg border border-white/10 bg-black/20 p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <div>
                    <span className="font-medium">{row.label}</span>{' '}
                    <span className="text-xs text-white/50">
                      (non-ETX leg: <ShortAddr value={row.nonEtx} />)
                    </span>
                  </div>
                  <div className="text-xs">
                    pair: <ShortAddr value={row.pair} />
                  </div>
                </div>
                <div className="mb-3 text-xs text-white/60">
                  current allowance(owner → harvester):{' '}
                  <span className="font-mono">
                    {row.allowance === null
                      ? '—'
                      : row.allowance === 0n
                        ? '0'
                        : row.allowance === MAX_UINT256
                          ? 'unlimited (max uint256)'
                          : row.allowance.toString()}
                  </span>
                </div>
                <button
                  onClick={() => doApproveLp(i)}
                  disabled={
                    !isAuthorized ||
                    !row.pair ||
                    row.pair === ZERO_ADDRESS ||
                    approveStates[i]?.status === 'signing' ||
                    approveStates[i]?.status === 'pending' ||
                    already
                  }
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
                >
                  {already ? 'Already approved' : `Approve ${row.label}`}
                </button>
                <StateBadge state={approveStates[i] ?? initial} />
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
