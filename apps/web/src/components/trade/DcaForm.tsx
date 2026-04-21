'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  formatUnits,
  maxUint256,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSignTypedData,
  useWaitForTransactionReceipt,
  useWalletClient,
  useWriteContract,
} from 'wagmi';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  abis,
  isSupportedChainId,
  type SupportedChainId,
} from '@etica-hub/shared';
import {
  buildDcaLegs,
  buildPermit2WitnessTypedData,
  encodeDutchOrder,
  randomDcaBatchId,
  type Side,
} from '@/lib/trading/dutchOrder';
import { resolveOrderbookUrl, submitOrder } from '@/lib/trading/orderbookClient';
import {
  buildDcaMeta,
  getRegistryAddress,
  postOrderBatchOnChain,
  toBatchIdBytes32,
} from '@/lib/trading/registryClient';

type BaseSymbol = 'ETI' | 'EGAZ';

export interface DcaFormProps {
  baseSymbol: BaseSymbol;
}

const INTERVAL_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: 'Hourly', seconds: 60 * 60 },
  { label: '6 hours', seconds: 6 * 60 * 60 },
  { label: 'Daily', seconds: 24 * 60 * 60 },
  { label: 'Weekly', seconds: 7 * 24 * 60 * 60 },
];

const ZERO: Address = '0x0000000000000000000000000000000000000000';

// Each leg stays fillable for this long past its scheduled start before it
// expires and the keeper drops it. Gives the reference keeper ample retry
// room without leaving orders open indefinitely.
const LEG_VALIDITY_SEC = 24 * 60 * 60;

export function DcaForm({ baseSymbol }: DcaFormProps) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const orderbookUrl = resolveOrderbookUrl();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const registryAddress = getRegistryAddress(chainId);

  const [side, setSide] = useState<Side>('buy');
  const [totalAmountStr, setTotalAmountStr] = useState('');
  const [priceStr, setPriceStr] = useState('');
  const [legsStr, setLegsStr] = useState('7');
  const [intervalSec, setIntervalSec] = useState<number>(INTERVAL_PRESETS[2].seconds);
  const [progress, setProgress] = useState<{ signed: number; total: number } | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const supported = isSupportedChainId(chainId);
  const deployment = supported ? DEPLOYMENTS[chainId] : null;
  const ext = supported ? EXTERNAL_ADDRESSES[chainId] : null;
  const permit2 = deployment?.permit2 ?? ZERO;
  const reactor = deployment?.dutchReactor ?? ZERO;
  const etxToken = deployment?.etx ?? ZERO;
  const baseToken: Address =
    baseSymbol === 'ETI' ? (ext?.eti ?? ZERO) : (deployment?.wegaz ?? ZERO);

  const tradingLive =
    (Boolean(orderbookUrl) || registryAddress !== null) && permit2 !== ZERO && reactor !== ZERO;

  const totalBaseAmount = useMemo(() => {
    if (!totalAmountStr) return 0n;
    try {
      return parseUnits(totalAmountStr, 18);
    } catch {
      return 0n;
    }
  }, [totalAmountStr]);

  const pricePerBase18 = useMemo(() => {
    if (!priceStr) return 0n;
    try {
      return parseUnits(priceStr, 18);
    } catch {
      return 0n;
    }
  }, [priceStr]);

  const legs = useMemo(() => {
    const n = Number(legsStr);
    if (!Number.isFinite(n)) return 0;
    return Math.floor(n);
  }, [legsStr]);

  const inputToken = side === 'sell' ? baseToken : etxToken;

  // Sum of per-leg input amounts. For a sell this is just the total base
  // amount; for a buy it's `totalBase × price / 1e18` (the quote side).
  const totalInputAmount =
    side === 'sell'
      ? totalBaseAmount
      : totalBaseAmount > 0n && pricePerBase18 > 0n
        ? (totalBaseAmount * pricePerBase18) / 10n ** 18n
        : 0n;

  const allowance = useReadContract({
    abi: abis.erc20Abi,
    address: inputToken,
    functionName: 'allowance',
    args: address && permit2 !== ZERO ? [address, permit2] : undefined,
    query: { enabled: Boolean(address && inputToken !== ZERO && tradingLive) },
  });
  const needsPermit2Approval =
    tradingLive &&
    totalInputAmount > 0n &&
    ((allowance.data as bigint | undefined) ?? 0n) < totalInputAmount;

  const { writeContractAsync, data: approveTxHash, reset: resetWrite } = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({
    hash: approveTxHash,
    query: { enabled: Boolean(approveTxHash) },
  });
  const { signTypedDataAsync } = useSignTypedData();

  const isApproving = Boolean(approveTxHash) && !approveReceipt.data && !approveReceipt.error;

  useEffect(() => {
    if (approveReceipt.isSuccess) {
      void allowance.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveReceipt.isSuccess]);

  async function onApprovePermit2() {
    if (!address || !tradingLive) return;
    setError(null);
    try {
      await writeContractAsync({
        abi: abis.erc20Abi,
        address: inputToken,
        functionName: 'approve',
        args: [permit2 as Address, maxUint256],
      });
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function onSign() {
    setError(null);
    setStatusLine(null);
    setProgress(null);
    if (!address || !isConnected) {
      setError('Connect a wallet first.');
      return;
    }
    if (!tradingLive) {
      setError('Order book + keeper are still deploying — DCA plans can be signed once they are online.');
      return;
    }
    if (registryAddress && (!walletClient || !publicClient)) {
      setError('Wallet session still loading — try again in a moment.');
      return;
    }
    if (totalBaseAmount <= 0n) {
      setError('Total amount must be greater than zero.');
      return;
    }
    if (pricePerBase18 <= 0n) {
      setError('Limit price must be greater than zero.');
      return;
    }
    if (legs < 2) {
      setError('DCA requires at least 2 legs.');
      return;
    }
    if (legs > 50) {
      setError('DCA is capped at 50 legs per batch.');
      return;
    }
    if (intervalSec < 60) {
      setError('Interval must be at least 60 seconds.');
      return;
    }
    if (needsPermit2Approval) {
      setError('Approve Permit2 before signing the DCA plan.');
      return;
    }

    const firstLegStartSec = Math.floor(Date.now() / 1000);
    const batchId = randomDcaBatchId();

    let plan;
    try {
      plan = buildDcaLegs({
        reactor: reactor as Address,
        swapper: address,
        side,
        baseToken,
        quoteToken: etxToken as Address,
        totalBaseAmount,
        pricePerBase18,
        baseDecimals: 18,
        quoteDecimals: 18,
        legs,
        intervalSec,
        firstLegStartSec,
        legValiditySec: LEG_VALIDITY_SEC,
      });
    } catch (err) {
      setError(formatError(err));
      return;
    }

    setSubmitting(true);
    setProgress({ signed: 0, total: plan.length });
    try {
      const useRegistry = Boolean(registryAddress && walletClient && publicClient && supported);
      const encodedByLeg: Hex[] = [];
      const signatureByLeg: Hex[] = [];
      for (let i = 0; i < plan.length; i += 1) {
        const leg = plan[i];
        setStatusLine(
          `Waiting for signature ${i + 1} of ${plan.length} (leg #${leg.index + 1})…`,
        );
        const encoded = encodeDutchOrder(leg.order);
        const typed = buildPermit2WitnessTypedData(leg.order, {
          chainId,
          permit2: permit2 as Address,
        });
        const signature = (await signTypedDataAsync({
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        })) as Hex;
        encodedByLeg.push(encoded);
        signatureByLeg.push(signature);
        setProgress({ signed: i + 1, total: plan.length });

        if (!useRegistry) {
          setStatusLine(`Submitting leg ${i + 1} of ${plan.length}…`);
          await submitOrder(orderbookUrl!, {
            encodedOrder: encoded,
            signature,
            strategyType: 'dca',
            dcaBatchId: batchId,
            dcaIndex: leg.index,
            dcaTotal: plan.length,
          });
        }
      }

      if (useRegistry && walletClient && publicClient) {
        setStatusLine(`Posting ${plan.length} legs on-chain in one tx…`);
        const batchIdBytes = toBatchIdBytes32(batchId);
        const metas = plan.map((leg) =>
          buildDcaMeta({
            batchId: batchIdBytes,
            indexInBatch: leg.index,
            totalInBatch: plan.length,
          }),
        );
        const { txHash } = await postOrderBatchOnChain({
          walletClient,
          publicClient,
          chainId: chainId as SupportedChainId,
          account: address,
          encodedOrders: encodedByLeg,
          signatures: signatureByLeg,
          metas,
        });
        setStatusLine(`Waiting for registry tx ${shortHash(txHash)}…`);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== 'success') {
          throw new Error('Registry batch tx reverted on-chain');
        }
      }

      setStatusLine(
        `DCA plan submitted (${plan.length} legs, batch ${batchId.slice(0, 8)}…). Keeper will fire legs on schedule.`,
      );
      setTotalAmountStr('');
      setPriceStr('');
      resetWrite();
    } catch (err) {
      setStatusLine(null);
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const perLegBase = legs > 1 && totalBaseAmount > 0n ? totalBaseAmount / BigInt(legs) : 0n;
  const scheduleCopy =
    legs > 1 && totalBaseAmount > 0n && pricePerBase18 > 0n
      ? `${side === 'buy' ? 'Buy' : 'Sell'} ${formatAmount(perLegBase)} ${baseSymbol} per leg, ${
          legs
        } legs, every ${formatInterval(intervalSec)} — ${
          side === 'buy' ? 'spending up to' : 'for at least'
        } ${formatAmount(totalInputAmount)} ${side === 'buy' ? 'ETX' : 'ETX total'}`
      : null;

  return (
    <div className="space-y-3">
      {!tradingLive ? (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4 text-xs">
          <div className="mb-1 uppercase tracking-wider text-amber-200/80">
            Coming soon — order book + keeper deploying
          </div>
          <p className="text-amber-100/80">
            The UniswapX reactor is live on Etica mainnet, but the order book and reference keeper
            are not yet online. You can wire up a plan below, but Sign stays disabled until orders
            can be routed to a keeper.
          </p>
        </div>
      ) : null}

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-3 flex gap-1 rounded-full border border-white/10 bg-white/5 p-1">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              className={`flex-1 rounded-full px-3 py-1.5 text-sm capitalize transition-colors ${
                side === s
                  ? s === 'buy'
                    ? 'bg-emerald-400/20 text-emerald-200'
                    : 'bg-rose-400/20 text-rose-200'
                  : 'text-white/70 hover:bg-white/5 hover:text-white'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wider text-white/60">
            Total {baseSymbol} across all legs
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={totalAmountStr}
            onChange={(e) => setTotalAmountStr(e.target.value)}
            placeholder="0.00"
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-accent"
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wider text-white/60">
            Limit price (ETX per {baseSymbol})
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={priceStr}
            onChange={(e) => setPriceStr(e.target.value)}
            placeholder="0.00"
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-accent"
          />
        </label>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-white/60">
              Legs (2–50)
            </span>
            <input
              type="number"
              min={2}
              max={50}
              value={legsStr}
              onChange={(e) => setLegsStr(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-white/60">
              Interval
            </span>
            <select
              value={intervalSec}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-accent"
            >
              {INTERVAL_PRESETS.map((p) => (
                <option key={p.seconds} value={p.seconds}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {scheduleCopy ? (
          <p className="mb-3 rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-white/70">
            {scheduleCopy}
          </p>
        ) : null}

        {needsPermit2Approval ? (
          <button
            type="button"
            onClick={onApprovePermit2}
            disabled={!tradingLive || isApproving}
            className="w-full rounded-xl bg-brand-accent px-3 py-2 text-sm font-semibold text-brand-ink disabled:opacity-50"
          >
            {isApproving
              ? 'Approving Permit2…'
              : `Approve Permit2 for ${formatAmount(totalInputAmount)} ${side === 'buy' ? 'ETX' : baseSymbol}`}
          </button>
        ) : (
          <button
            type="button"
            onClick={onSign}
            disabled={!tradingLive || submitting}
            className="w-full rounded-xl bg-brand-accent px-3 py-2 text-sm font-semibold text-brand-ink disabled:opacity-50"
          >
            {submitting
              ? progress && progress.signed < progress.total
                ? `Signing ${progress.signed + 1} of ${progress.total}…`
                : 'Submitting…'
              : `Sign ${legs || 0}-leg DCA plan`}
          </button>
        )}

        {statusLine ? (
          <p className="mt-3 text-xs text-white/70">{statusLine}</p>
        ) : null}
        {error ? <p className="mt-3 text-xs text-rose-300">{error}</p> : null}
      </div>

      <p className="text-xs text-white/50">
        DCA legs are separate pre-signed limit orders released on schedule by the keeper —
        funds stay in your wallet until each leg fills. Cancel any leg individually from
        the orders dashboard.
      </p>
    </div>
  );
}

function formatError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Signature rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage || err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatAmount(value: bigint): string {
  if (value === 0n) return '0';
  const whole = formatUnits(value, 18);
  const [intPart, fracPart = ''] = whole.split('.');
  const trimmedFrac = fracPart.slice(0, 6).replace(/0+$/, '');
  return trimmedFrac ? `${intPart}.${trimmedFrac}` : intPart;
}

function formatInterval(sec: number): string {
  if (sec >= 7 * 24 * 60 * 60) return `${Math.floor(sec / (7 * 24 * 60 * 60))}w`;
  if (sec >= 24 * 60 * 60) return `${Math.floor(sec / (24 * 60 * 60))}d`;
  if (sec >= 60 * 60) return `${Math.floor(sec / (60 * 60))}h`;
  return `${Math.floor(sec / 60)}m`;
}

function shortHash(hex: Hex): string {
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}
