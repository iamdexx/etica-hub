'use client';

import { useEffect, useState } from 'react';
import { BaseError, UserRejectedRequestError, formatUnits, type Address, type Hex } from 'viem';
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

const poolAbi = abis.eticaStableSwapAbi;
const timelockAbi = abis.liquidityTimelock10yAbi;
const adapterAbi = abis.stableSwapHarvesterAdapterAbi;

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
      className="font-mono text-emerald-400 break-all hover:underline"
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
      <div className="mt-2 rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
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
    <div className="mt-2 text-xs text-white/60">
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

function fmt(n: bigint | null, decimals = 18, maxFrac = 4) {
  if (n === null) return '—';
  const s = formatUnits(n, decimals);
  const [int, frac = ''] = s.split('.');
  if (!frac) return int;
  return `${int}.${frac.slice(0, maxFrac)}`;
}

function formatSeconds(sec: bigint): string {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return 'unlocked';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

export function AdminStableSwapCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const D = DEPLOYMENTS[eticaMainnet.id];
  const pool = D.eticaStableSwap as Address;
  const timelock = D.liquidityTimelock10y as Address;
  const adapter = D.stableSwapHarvesterAdapter as Address;
  const wired = pool !== ZERO_ADDRESS && timelock !== ZERO_ADDRESS && adapter !== ZERO_ADDRESS;

  const [poolOwner, setPoolOwner] = useState<Address | null>(null);
  const [reserveEtx, setReserveEtx] = useState<bigint | null>(null);
  const [reserveStEtx, setReserveStEtx] = useState<bigint | null>(null);
  const [adminFeeEtx, setAdminFeeEtx] = useState<bigint | null>(null);
  const [adminFeeStEtx, setAdminFeeStEtx] = useState<bigint | null>(null);
  const [swapFeeBps, setSwapFeeBps] = useState<bigint | null>(null);
  const [adminFeeBps, setAdminFeeBps] = useState<bigint | null>(null);
  const [adminFeeRecipient, setAdminFeeRecipient] = useState<Address | null>(null);
  const [getA, setGetA] = useState<bigint | null>(null);
  const [futureA, setFutureA] = useState<bigint | null>(null);
  const [futureATime, setFutureATime] = useState<bigint | null>(null);
  const [rate, setRate] = useState<bigint | null>(null);
  const [totalLp, setTotalLp] = useState<bigint | null>(null);

  const [tlOwner, setTlOwner] = useState<Address | null>(null);
  const [tlLockedAmount, setTlLockedAmount] = useState<bigint | null>(null);
  const [tlUnlockTime, setTlUnlockTime] = useState<bigint | null>(null);
  const [tlTimeUntilUnlock, setTlTimeUntilUnlock] = useState<bigint | null>(null);
  const [tlFreeBalance, setTlFreeBalance] = useState<bigint | null>(null);

  const [reloadTick, setReloadTick] = useState(0);
  const refresh = () => setReloadTick((x) => x + 1);

  useEffect(() => {
    if (!publicClient || !wired) return;
    let cancelled = false;
    (async () => {
      try {
        const [
          ownerR,
          rEtx,
          rStEtx,
          afEtx,
          afStEtx,
          swapBps,
          adminBps,
          recipient,
          aReal,
          fA,
          fAT,
          rateR,
          tsR,
        ] = await Promise.all([
          publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'owner' }),
          publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'reserveEtx' }),
          publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'reserveStEtx' }),
          publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'adminFeeEtx' }),
          publicClient.readContract({
            address: pool,
            abi: poolAbi,
            functionName: 'adminFeeStEtx',
          }),
          publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'swapFeeBps' }),
          publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'adminFeeBps' }),
          publicClient.readContract({
            address: pool,
            abi: poolAbi,
            functionName: 'adminFeeRecipient',
          }),
          publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'getA' }),
          publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'futureA' }),
          publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'futureATime' }),
          publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'getRate' }),
          publicClient.readContract({ address: pool, abi: poolAbi, functionName: 'totalSupply' }),
        ]);
        if (cancelled) return;
        setPoolOwner(ownerR as Address);
        setReserveEtx(BigInt(rEtx as bigint));
        setReserveStEtx(BigInt(rStEtx as bigint));
        setAdminFeeEtx(BigInt(afEtx as bigint));
        setAdminFeeStEtx(BigInt(afStEtx as bigint));
        setSwapFeeBps(BigInt(swapBps as number));
        setAdminFeeBps(BigInt(adminBps as number));
        setAdminFeeRecipient(recipient as Address);
        setGetA(BigInt(aReal as bigint));
        setFutureA(BigInt(fA as bigint));
        setFutureATime(BigInt(fAT as bigint));
        setRate(BigInt(rateR as bigint));
        setTotalLp(BigInt(tsR as bigint));
      } catch {
        /* leave as-is */
      }
      try {
        const [tlOwnerR, locked, unlock, timeLeft, freeBal] = await Promise.all([
          publicClient.readContract({
            address: timelock,
            abi: timelockAbi,
            functionName: 'owner',
          }),
          publicClient.readContract({
            address: timelock,
            abi: timelockAbi,
            functionName: 'lockedAmount',
          }),
          publicClient.readContract({
            address: timelock,
            abi: timelockAbi,
            functionName: 'unlockTime',
          }),
          publicClient.readContract({
            address: timelock,
            abi: timelockAbi,
            functionName: 'timeUntilUnlock',
          }),
          publicClient.readContract({
            address: timelock,
            abi: timelockAbi,
            functionName: 'freeBalance',
          }),
        ]);
        if (cancelled) return;
        setTlOwner(tlOwnerR as Address);
        setTlLockedAmount(BigInt(locked as bigint));
        setTlUnlockTime(BigInt(unlock as bigint));
        setTlTimeUntilUnlock(BigInt(timeLeft as bigint));
        setTlFreeBalance(BigInt(freeBal as bigint));
      } catch {
        /* leave as-is */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, wired, pool, timelock, reloadTick]);

  // ─── form state ─────────────────────────────────────────────────────
  const [newSwapFeeBps, setNewSwapFeeBps] = useState('4');
  const [newAdminFeeBps, setNewAdminFeeBps] = useState('5000');
  const [newRecipient, setNewRecipient] = useState('');
  const [newARealInput, setNewARealInput] = useState('');
  const [rampEndDays, setRampEndDays] = useState('14');
  const [withdrawTo, setWithdrawTo] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');

  // ─── tx state ───────────────────────────────────────────────────────
  const [claimState, setClaimState] = useState<TxState>(initial);
  const [setSwapFeeState, setSetSwapFeeState] = useState<TxState>(initial);
  const [setAdminFeeState, setSetAdminFeeState] = useState<TxState>(initial);
  const [setRecipientState, setSetRecipientState] = useState<TxState>(initial);
  const [rampState, setRampState] = useState<TxState>(initial);
  const [stopRampState, setStopRampState] = useState<TxState>(initial);
  const [harvestState, setHarvestState] = useState<TxState>(initial);
  const [lockedWithdrawState, setLockedWithdrawState] = useState<TxState>(initial);

  async function runWrite(
    setter: (s: TxState) => void,
    fn: () => Promise<Hex>,
  ): Promise<void> {
    if (!publicClient) return;
    setter({ status: 'signing' });
    try {
      const hash = await fn();
      setter({ status: 'pending', txHash: hash });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') {
        setter({ status: 'error', txHash: hash, error: 'Reverted' });
        return;
      }
      setter({ status: 'confirmed', txHash: hash });
      refresh();
    } catch (err) {
      setter({ status: 'error', error: shortError(err) });
    }
  }

  async function doClaim() {
    if (!walletClient) return;
    await runWrite(setClaimState, () =>
      walletClient.writeContract({
        address: pool,
        abi: poolAbi,
        functionName: 'claimAdminFees',
        args: [],
      }),
    );
  }

  async function doSetSwapFee() {
    if (!walletClient) return;
    const v = Number(newSwapFeeBps);
    if (!Number.isFinite(v) || v < 0 || v > 100) return;
    await runWrite(setSetSwapFeeState, () =>
      walletClient.writeContract({
        address: pool,
        abi: poolAbi,
        functionName: 'setSwapFee',
        args: [v],
      }),
    );
  }

  async function doSetAdminFee() {
    if (!walletClient) return;
    const v = Number(newAdminFeeBps);
    if (!Number.isFinite(v) || v < 0 || v > 10_000) return;
    await runWrite(setSetAdminFeeState, () =>
      walletClient.writeContract({
        address: pool,
        abi: poolAbi,
        functionName: 'setAdminFee',
        args: [v],
      }),
    );
  }

  async function doSetRecipient() {
    if (!walletClient) return;
    const r = newRecipient.trim() as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(r)) return;
    await runWrite(setSetRecipientState, () =>
      walletClient.writeContract({
        address: pool,
        abi: poolAbi,
        functionName: 'setAdminFeeRecipient',
        args: [r],
      }),
    );
  }

  async function doRamp() {
    if (!walletClient) return;
    const a = Number(newARealInput);
    const days = Number(rampEndDays);
    if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(days) || days <= 0) return;
    const endTime = BigInt(Math.floor(Date.now() / 1000) + Math.floor(days * 86400));
    await runWrite(setRampState, () =>
      walletClient.writeContract({
        address: pool,
        abi: poolAbi,
        functionName: 'rampA',
        args: [BigInt(Math.floor(a)), endTime],
      }),
    );
  }

  async function doStopRamp() {
    if (!walletClient) return;
    await runWrite(setStopRampState, () =>
      walletClient.writeContract({
        address: pool,
        abi: poolAbi,
        functionName: 'stopRampA',
        args: [],
      }),
    );
  }

  async function doHarvest() {
    if (!walletClient) return;
    await runWrite(setHarvestState, () =>
      walletClient.writeContract({
        address: adapter,
        abi: adapterAbi,
        functionName: 'harvest',
        args: [],
      }),
    );
  }

  async function doLockedWithdraw() {
    if (!walletClient) return;
    const to = withdrawTo.trim() as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return;
    const amt = withdrawAmount.trim();
    if (!/^\d+$/.test(amt)) return;
    await runWrite(setLockedWithdrawState, () =>
      walletClient.writeContract({
        address: timelock,
        abi: timelockAbi,
        functionName: 'lockedWithdraw',
        args: [to, BigInt(amt)],
      }),
    );
  }

  const injected = connectors.find((c) => c.id === 'injected') ?? connectors[0];
  const isOwner =
    isConnected && address && poolOwner && address.toLowerCase() === poolOwner.toLowerCase();
  const tvlEtx =
    reserveEtx !== null && reserveStEtx !== null && rate !== null
      ? reserveEtx + (reserveStEtx * rate) / 10n ** 18n
      : null;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Wallet</h2>
        {!isConnected ? (
          <button
            type="button"
            className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
            onClick={() => injected && connect({ connector: injected })}
            disabled={connectStatus === 'pending' || !injected}
          >
            {connectStatus === 'pending' ? 'Connecting…' : 'Connect wallet'}
          </button>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-white/60">Connected:</span>
              <span className="font-mono break-all">{address}</span>
              <button
                type="button"
                className="ml-auto rounded-md border border-white/15 px-3 py-1 text-xs text-white/70 hover:bg-white/5"
                onClick={() => disconnect()}
              >
                Disconnect
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-white/60">Chain:</span>
              <span className="font-mono">{chainId}</span>
              {!onMainnet && (
                <button
                  type="button"
                  className="rounded-md bg-amber-400/90 px-3 py-1 text-xs font-medium text-black hover:bg-amber-300"
                  onClick={() => switchChain({ chainId: eticaMainnet.id })}
                  disabled={switching}
                >
                  {switching ? 'Switching…' : 'Switch to Etica Mainnet'}
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {!wired && (
        <section className="rounded-xl border border-amber-300/30 bg-amber-400/5 p-5 text-sm text-amber-100/90">
          StableSwap addresses not yet wired in <span className="font-mono">addresses.ts</span>.
          Deploy at{' '}
          <a className="text-emerald-400 hover:underline" href="/deploy/stableswap-pool">
            /deploy/stableswap-pool
          </a>{' '}
          first, then paste the addresses into{' '}
          <span className="font-mono">DEPLOYMENTS[{chainId}]</span>.
        </section>
      )}

      <section className="rounded-xl border border-white/10 bg-white/5 p-5 text-sm">
        <h2 className="mb-3 text-lg font-semibold">Pool state</h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <Row label="Pool" value={<ShortAddr value={pool === ZERO_ADDRESS ? null : pool} />} />
          <Row
            label="Owner"
            value={<ShortAddr value={poolOwner ?? (pool === ZERO_ADDRESS ? null : null)} />}
          />
          <Row label="Reserve ETX" value={<span className="font-mono">{fmt(reserveEtx)}</span>} />
          <Row
            label="Reserve stETX"
            value={<span className="font-mono">{fmt(reserveStEtx)}</span>}
          />
          <Row
            label="NAV (ETX per stETX)"
            value={<span className="font-mono">{fmt(rate, 18, 6)}</span>}
          />
          <Row label="LP supply" value={<span className="font-mono">{fmt(totalLp)}</span>} />
          <Row
            label="TVL (ETX-equiv)"
            value={<span className="font-mono">{fmt(tvlEtx)}</span>}
          />
          <Row
            label="A coefficient (live)"
            value={<span className="font-mono">{getA === null ? '—' : (getA / 100n).toString()}</span>}
          />
          <Row
            label="A target"
            value={
              <span className="font-mono">
                {futureA === null ? '—' : (futureA / 100n).toString()}
                {futureATime !== null && futureATime > 0n ? (
                  <span className="text-white/40"> · ends {Number(futureATime)}</span>
                ) : null}
              </span>
            }
          />
          <Row
            label="Swap fee"
            value={
              <span className="font-mono">
                {swapFeeBps === null ? '—' : `${Number(swapFeeBps) / 100} bps`}
              </span>
            }
          />
          <Row
            label="Admin slice"
            value={
              <span className="font-mono">
                {adminFeeBps === null ? '—' : `${Number(adminFeeBps) / 100}%`}
              </span>
            }
          />
          <Row
            label="Pending admin fees"
            value={
              <span className="font-mono">
                {fmt(adminFeeEtx)} ETX · {fmt(adminFeeStEtx)} stETX
              </span>
            }
          />
          <Row label="Admin recipient" value={<ShortAddr value={adminFeeRecipient} />} />
        </dl>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5 text-sm">
        <h2 className="mb-3 text-lg font-semibold">Treasury timelock</h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <Row
            label="Timelock"
            value={<ShortAddr value={timelock === ZERO_ADDRESS ? null : timelock} />}
          />
          <Row label="Owner" value={<ShortAddr value={tlOwner} />} />
          <Row
            label="Locked esLP"
            value={<span className="font-mono">{fmt(tlLockedAmount)}</span>}
          />
          <Row
            label="Unlock time"
            value={
              <span className="font-mono">
                {tlUnlockTime === null
                  ? '—'
                  : new Date(Number(tlUnlockTime) * 1000).toISOString().slice(0, 10)}
              </span>
            }
          />
          <Row
            label="Time until unlock"
            value={
              <span className="font-mono">
                {tlTimeUntilUnlock === null ? '—' : formatSeconds(tlTimeUntilUnlock)}
              </span>
            }
          />
          <Row
            label="Free balance (excess)"
            value={<span className="font-mono">{fmt(tlFreeBalance)}</span>}
          />
        </dl>
      </section>

      <Action
        title="Claim admin fees → adapter"
        body="Permissionless. Sweeps pending admin fees from the pool to the configured recipient (the harvester adapter when wired). After this, anyone can call harvest() to run the 10/10/40/40 split."
        button="Claim admin fees"
        state={claimState}
        disabled={!wired || !walletClient}
        onClick={doClaim}
      />

      <Action
        title="Run harvest now"
        body="Permissionless. Splits the adapter's ETX balance 10/10/40/40 and burns the POL slice into the pool itself. Reverts if the adapter has no ETX (call Claim first)."
        button="Harvest"
        state={harvestState}
        disabled={!wired || !walletClient}
        onClick={doHarvest}
      />

      <FormBlock title="Set swap fee (owner only)" disabled={!isOwner}>
        <NumberField
          label="New swap fee (bps, max 100)"
          value={newSwapFeeBps}
          onChange={setNewSwapFeeBps}
        />
        <button
          type="button"
          className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
          onClick={doSetSwapFee}
          disabled={!isOwner || !walletClient}
        >
          {setSwapFeeState.status === 'signing' ? 'Sign in wallet…' : 'Update swap fee'}
        </button>
        <StateBadge state={setSwapFeeState} />
      </FormBlock>

      <FormBlock title="Set admin fee slice (owner only)" disabled={!isOwner}>
        <NumberField
          label="New admin slice (bps of fee, max 10000)"
          value={newAdminFeeBps}
          onChange={setNewAdminFeeBps}
        />
        <button
          type="button"
          className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
          onClick={doSetAdminFee}
          disabled={!isOwner || !walletClient}
        >
          {setAdminFeeState.status === 'signing' ? 'Sign in wallet…' : 'Update admin slice'}
        </button>
        <StateBadge state={setAdminFeeState} />
      </FormBlock>

      <FormBlock title="Set admin-fee recipient (owner only)" disabled={!isOwner}>
        <Field
          label="Recipient address"
          value={newRecipient}
          onChange={setNewRecipient}
          placeholder="0x…"
          mono
        />
        <button
          type="button"
          className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
          onClick={doSetRecipient}
          disabled={!isOwner || !walletClient}
        >
          {setRecipientState.status === 'signing' ? 'Sign in wallet…' : 'Update recipient'}
        </button>
        <StateBadge state={setRecipientState} />
      </FormBlock>

      <FormBlock title="Ramp A coefficient (owner only)" disabled={!isOwner}>
        <NumberField
          label="New A target (must be within 10× current)"
          value={newARealInput}
          onChange={setNewARealInput}
          placeholder="400"
        />
        <NumberField
          label="Ramp duration (days, min 1)"
          value={rampEndDays}
          onChange={setRampEndDays}
          placeholder="14"
        />
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
            onClick={doRamp}
            disabled={!isOwner || !walletClient}
          >
            {rampState.status === 'signing' ? 'Sign in wallet…' : 'Start ramp'}
          </button>
          <button
            type="button"
            className="rounded-md border border-white/15 px-4 py-2 text-sm text-white/80 hover:bg-white/5 disabled:opacity-40"
            onClick={doStopRamp}
            disabled={!isOwner || !walletClient}
          >
            {stopRampState.status === 'signing' ? 'Sign in wallet…' : 'Stop ramp'}
          </button>
        </div>
        <StateBadge state={rampState} />
        <StateBadge state={stopRampState} />
      </FormBlock>

      <FormBlock
        title="Locked withdraw (treasury only, after unlock)"
        disabled={
          !isConnected ||
          !tlOwner ||
          !address ||
          tlOwner.toLowerCase() !== address.toLowerCase() ||
          tlTimeUntilUnlock === null ||
          tlTimeUntilUnlock > 0n
        }
      >
        <p className="text-xs text-white/60">
          Disabled until <span className="font-mono">timeUntilUnlock</span> reaches 0. Available 10
          years after deploy. Use{' '}
          <span className="font-mono">withdrawExcess</span> via direct contract call if you need to
          sweep accidental over-deposits today.
        </p>
        <Field label="Recipient" value={withdrawTo} onChange={setWithdrawTo} placeholder="0x…" mono />
        <Field
          label="Amount (wei)"
          value={withdrawAmount}
          onChange={setWithdrawAmount}
          placeholder="esLP wei"
          mono
        />
        <button
          type="button"
          className="rounded-md bg-rose-500/80 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-400 disabled:opacity-40"
          onClick={doLockedWithdraw}
          disabled={
            !walletClient ||
            tlTimeUntilUnlock === null ||
            tlTimeUntilUnlock > 0n
          }
        >
          {lockedWithdrawState.status === 'signing' ? 'Sign in wallet…' : 'Locked withdraw'}
        </button>
        <StateBadge state={lockedWithdrawState} />
      </FormBlock>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-white/60">{label}</dt>
      <dd className="text-white/90">{value}</dd>
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="block text-xs text-white/70">
      {label}
      <input
        type="text"
        className={`mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-xs text-white placeholder:text-white/30 ${mono ? 'font-mono' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block text-xs text-white/70">
      {label}
      <input
        type="text"
        inputMode="numeric"
        className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-xs text-white placeholder:text-white/30"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function FormBlock({
  title,
  disabled,
  children,
}: {
  title: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-xl border border-white/10 bg-white/5 p-5 ${disabled ? 'opacity-60' : ''}`}
    >
      <h3 className="mb-3 text-sm font-semibold text-white/90">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Action({
  title,
  body,
  button,
  state,
  disabled,
  onClick,
}: {
  title: string;
  body: string;
  button: string;
  state: TxState;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <h3 className="mb-1 text-sm font-semibold text-white/90">{title}</h3>
      <p className="mb-3 text-xs text-white/60">{body}</p>
      <button
        type="button"
        className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
        onClick={onClick}
        disabled={disabled}
      >
        {state.status === 'signing'
          ? 'Sign in wallet…'
          : state.status === 'pending'
            ? 'Waiting for confirmation…'
            : button}
      </button>
      <StateBadge state={state} />
    </section>
  );
}
