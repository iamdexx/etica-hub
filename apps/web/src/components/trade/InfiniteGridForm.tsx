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
  useReadContract,
  useSignTypedData,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES, abis, isSupportedChainId } from '@etica-hub/shared';
import {
  buildInfiniteGridLegs,
  buildPermit2WitnessTypedData,
  encodeDutchOrder,
  randomGridBatchId,
  type GridLevel,
} from '@/lib/trading/dutchOrder';
import { resolveOrderbookUrl, submitOrder } from '@/lib/trading/orderbookClient';

type BaseSymbol = 'ETI' | 'EGAZ';

export interface InfiniteGridFormProps {
  baseSymbol: BaseSymbol;
}

const ZERO: Address = '0x0000000000000000000000000000000000000000';

// Infinite grids stay active for 7 days. The "infinite" label is about the
// spacing model (unbounded, fixed-percent steps around a reference) not the
// validity window — the user re-signs a fresh batch when price walks past
// the outermost level on either side.
const INFINITE_GRID_VALIDITY_SEC = 7 * 24 * 60 * 60;

export function InfiniteGridForm({ baseSymbol }: InfiniteGridFormProps) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const orderbookUrl = resolveOrderbookUrl();

  const [refPriceStr, setRefPriceStr] = useState('');
  const [stepPctStr, setStepPctStr] = useState('2');
  const [buyLevelsStr, setBuyLevelsStr] = useState('8');
  const [sellLevelsStr, setSellLevelsStr] = useState('8');
  const [basePerLevelStr, setBasePerLevelStr] = useState('');
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

  const tradingLive = Boolean(orderbookUrl) && permit2 !== ZERO && reactor !== ZERO;

  const refPrice18 = useMemo(() => parseDecimal(refPriceStr), [refPriceStr]);
  const stepPctE18 = useMemo(() => parsePct(stepPctStr), [stepPctStr]);
  const basePerLevel = useMemo(() => parseDecimal(basePerLevelStr), [basePerLevelStr]);
  const buyLevels = useMemo(() => parseIntSafe(buyLevelsStr), [buyLevelsStr]);
  const sellLevels = useMemo(() => parseIntSafe(sellLevelsStr), [sellLevelsStr]);

  // Preview the plan so users can sanity-check range / amounts before signing.
  // `buildInfiniteGridLegs` validates inputs; we just render its output.
  const plan: GridLevel[] | null = useMemo(() => {
    if (!address || reactor === ZERO || baseToken === ZERO || etxToken === ZERO) return null;
    if (refPrice18 <= 0n || stepPctE18 <= 0n || basePerLevel <= 0n) return null;
    if (buyLevels + sellLevels < 1 || buyLevels + sellLevels > 50) return null;
    const startSec = Math.floor(Date.now() / 1000);
    try {
      return buildInfiniteGridLegs({
        reactor: reactor as Address,
        swapper: address,
        baseToken,
        quoteToken: etxToken as Address,
        baseDecimals: 18,
        quoteDecimals: 18,
        referencePrice18: refPrice18,
        stepPctE18,
        buyLevels,
        sellLevels,
        baseAmountPerLevel: basePerLevel,
        startSec,
        deadlineSec: startSec + INFINITE_GRID_VALIDITY_SEC,
        // Deterministic nonces in the preview so this memo isn't invalidated
        // every render; real signing path regenerates with secure random nonces.
        nonceGenerator: (() => {
          let i = 1n;
          return () => i++;
        })(),
      });
    } catch {
      return null;
    }
  }, [address, reactor, baseToken, etxToken, refPrice18, stepPctE18, buyLevels, sellLevels, basePerLevel]);

  const planBuyLevels = useMemo(() => plan?.filter((l) => l.side === 'buy') ?? [], [plan]);
  const planSellLevels = useMemo(() => plan?.filter((l) => l.side === 'sell') ?? [], [plan]);

  // Bottom / top of the active range — exposed in the preview so the user
  // knows where they'll need to re-sign when price walks past it.
  const bottomPrice = planBuyLevels[0]?.pricePerBase18 ?? 0n;
  const topPrice = planSellLevels[planSellLevels.length - 1]?.pricePerBase18 ?? 0n;

  // Approvals: buy legs spend ETX, sell legs spend base.
  const totalEtxInput = useMemo(() => {
    let sum = 0n;
    for (const lvl of planBuyLevels) {
      sum += (basePerLevel * lvl.pricePerBase18) / 10n ** 18n;
    }
    return sum;
  }, [planBuyLevels, basePerLevel]);
  const totalBaseInput = BigInt(planSellLevels.length) * basePerLevel;

  const etxAllowance = useReadContract({
    abi: abis.erc20Abi,
    address: etxToken,
    functionName: 'allowance',
    args: address && permit2 !== ZERO ? [address, permit2] : undefined,
    query: { enabled: Boolean(address && etxToken !== ZERO && tradingLive) },
  });
  const baseAllowance = useReadContract({
    abi: abis.erc20Abi,
    address: baseToken,
    functionName: 'allowance',
    args: address && permit2 !== ZERO ? [address, permit2] : undefined,
    query: { enabled: Boolean(address && baseToken !== ZERO && tradingLive) },
  });
  const needsEtxApproval =
    tradingLive &&
    totalEtxInput > 0n &&
    ((etxAllowance.data as bigint | undefined) ?? 0n) < totalEtxInput;
  const needsBaseApproval =
    tradingLive &&
    totalBaseInput > 0n &&
    ((baseAllowance.data as bigint | undefined) ?? 0n) < totalBaseInput;

  const { writeContractAsync, data: approveTxHash, reset: resetWrite } = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({
    hash: approveTxHash,
    query: { enabled: Boolean(approveTxHash) },
  });
  const { signTypedDataAsync } = useSignTypedData();

  const isApproving = Boolean(approveTxHash) && !approveReceipt.data && !approveReceipt.error;

  // Refetch allowances on successful Permit2 approval so the Sign button can
  // enable without waiting for TanStack Query's stale-time refetch. Same
  // pattern GridForm / DcaForm / OrderForm use.
  useEffect(() => {
    if (approveReceipt.isSuccess) {
      void etxAllowance.refetch();
      void baseAllowance.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveReceipt.isSuccess]);

  async function onApprove(token: Address) {
    if (!address || !tradingLive) return;
    setError(null);
    try {
      await writeContractAsync({
        abi: abis.erc20Abi,
        address: token,
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
    if (!tradingLive || !orderbookUrl) {
      setError(
        'Order book + keeper are still deploying — grids can be signed once they are online.',
      );
      return;
    }
    if (refPrice18 <= 0n) {
      setError('Reference price must be greater than zero.');
      return;
    }
    if (stepPctE18 <= 0n) {
      setError('Step % must be greater than zero.');
      return;
    }
    if (basePerLevel <= 0n) {
      setError(`${baseSymbol} per level must be greater than zero.`);
      return;
    }
    if (buyLevels + sellLevels < 1) {
      setError('Need at least one level (buy or sell).');
      return;
    }
    if (buyLevels + sellLevels > 50) {
      setError('Total levels (buys + sells) cannot exceed 50.');
      return;
    }
    if (needsEtxApproval || needsBaseApproval) {
      setError('Approve Permit2 for ETX and the base token before signing the grid.');
      return;
    }

    const startSec = Math.floor(Date.now() / 1000);
    const batchId = randomGridBatchId();
    let legs: GridLevel[];
    try {
      legs = buildInfiniteGridLegs({
        reactor: reactor as Address,
        swapper: address,
        baseToken,
        quoteToken: etxToken as Address,
        baseDecimals: 18,
        quoteDecimals: 18,
        referencePrice18: refPrice18,
        stepPctE18,
        buyLevels,
        sellLevels,
        baseAmountPerLevel: basePerLevel,
        startSec,
        deadlineSec: startSec + INFINITE_GRID_VALIDITY_SEC,
      });
    } catch (err) {
      setError(formatError(err));
      return;
    }

    if (legs.length === 0) {
      setError('Grid produced zero levels — bump the buy or sell count.');
      return;
    }

    setSubmitting(true);
    setProgress({ signed: 0, total: legs.length });
    try {
      for (let i = 0; i < legs.length; i += 1) {
        const lvl = legs[i];
        setStatusLine(
          `Waiting for signature ${i + 1} of ${legs.length} (${lvl.side} @ ${formatPrice(lvl.pricePerBase18)})…`,
        );
        const encoded = encodeDutchOrder(lvl.order);
        const typed = buildPermit2WitnessTypedData(lvl.order, {
          chainId,
          permit2: permit2 as Address,
        });
        const signature = (await signTypedDataAsync({
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        })) as Hex;

        setStatusLine(`Submitting level ${i + 1} of ${legs.length}…`);
        await submitOrder(orderbookUrl, {
          encodedOrder: encoded,
          signature,
          // Reuse the 'grid' strategy bucket on the orderbook side — the
          // dashboard renders infinite-grid batches the same way (pre-signed
          // limit orders grouped by batchId).
          strategyType: 'grid',
          gridBatchId: batchId,
          gridIndex: lvl.index,
          gridTotal: legs.length,
          gridLevelPrice: lvl.pricePerBase18.toString(),
        });

        setProgress({ signed: i + 1, total: legs.length });
      }

      setStatusLine(
        `Infinite grid submitted (${legs.length} levels, batch ${batchId.slice(0, 8)}…). Re-sign a new batch when price walks past ${formatPrice(bottomPrice)} or ${formatPrice(topPrice)}.`,
      );
      setRefPriceStr('');
      setBasePerLevelStr('');
      resetWrite();
    } catch (err) {
      setStatusLine(null);
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3">
      {!tradingLive ? (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4 text-xs">
          <div className="mb-1 uppercase tracking-wider text-amber-200/80">
            Coming soon — order book + keeper deploying
          </div>
          <p className="text-amber-100/80">
            The UniswapX reactor is live on Etica mainnet, but the order book and reference keeper
            are not yet online. You can configure a grid below, but Sign stays disabled until orders
            can be routed to a keeper.
          </p>
        </div>
      ) : null}

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wider text-white/60">
            Reference price (ETX per {baseSymbol})
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={refPriceStr}
            onChange={(e) => setRefPriceStr(e.target.value)}
            placeholder="current market"
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-accent"
          />
          <span className="mt-1 block text-[11px] text-white/50">
            Levels are placed geometrically around this price at the step % you choose.
          </span>
        </label>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-white/60">
              Step %
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={stepPctStr}
              onChange={(e) => setStepPctStr(e.target.value)}
              placeholder="e.g. 2"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-white/60">
              {baseSymbol} per level
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={basePerLevelStr}
              onChange={(e) => setBasePerLevelStr(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-accent"
            />
          </label>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-white/60">
              Buy levels below
            </span>
            <input
              type="number"
              min={0}
              max={50}
              value={buyLevelsStr}
              onChange={(e) => setBuyLevelsStr(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-white/60">
              Sell levels above
            </span>
            <input
              type="number"
              min={0}
              max={50}
              value={sellLevelsStr}
              onChange={(e) => setSellLevelsStr(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-accent"
            />
          </label>
        </div>

        {plan ? (
          <p className="mb-3 rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-white/70">
            {planBuyLevels.length} buy level{planBuyLevels.length === 1 ? '' : 's'} ·{' '}
            {planSellLevels.length} sell level{planSellLevels.length === 1 ? '' : 's'} spanning{' '}
            {formatPrice(bottomPrice)} – {formatPrice(topPrice)}. Commits up to{' '}
            {formatAmount(totalEtxInput)} ETX + {formatAmount(totalBaseInput)} {baseSymbol} across{' '}
            {plan.length} signature{plan.length === 1 ? '' : 's'}.
          </p>
        ) : null}

        {needsEtxApproval ? (
          <button
            type="button"
            onClick={() => onApprove(etxToken)}
            disabled={!tradingLive || isApproving}
            className="mb-2 w-full rounded-xl bg-brand-accent px-3 py-2 text-sm font-semibold text-brand-ink disabled:opacity-50"
          >
            {isApproving
              ? 'Approving Permit2 for ETX…'
              : `Approve Permit2 for ${formatAmount(totalEtxInput)} ETX`}
          </button>
        ) : null}
        {needsBaseApproval ? (
          <button
            type="button"
            onClick={() => onApprove(baseToken)}
            disabled={!tradingLive || isApproving}
            className="mb-2 w-full rounded-xl bg-brand-accent px-3 py-2 text-sm font-semibold text-brand-ink disabled:opacity-50"
          >
            {isApproving
              ? `Approving Permit2 for ${baseSymbol}…`
              : `Approve Permit2 for ${formatAmount(totalBaseInput)} ${baseSymbol}`}
          </button>
        ) : null}

        <button
          type="button"
          onClick={onSign}
          disabled={!tradingLive || submitting || needsEtxApproval || needsBaseApproval}
          className="w-full rounded-xl bg-brand-accent px-3 py-2 text-sm font-semibold text-brand-ink disabled:opacity-50"
        >
          {submitting
            ? progress
              ? `Signing ${progress.signed + 1} of ${progress.total}…`
              : 'Submitting…'
            : `Sign ${plan?.length ?? 0}-level infinite grid`}
        </button>

        {statusLine ? <p className="mt-3 text-xs text-white/70">{statusLine}</p> : null}
        {error ? <p className="mt-3 text-xs text-rose-300">{error}</p> : null}
      </div>

      <p className="text-xs text-white/50">
        Infinite grids place levels at fixed % spacing around the reference with no hard upper or
        lower bound. When the market walks past the outermost level, sign another batch to extend
        the grid in that direction. Each batch is tracked independently in the orders dashboard.
      </p>
    </div>
  );
}

function parseDecimal(s: string): bigint {
  if (!s) return 0n;
  try {
    return parseUnits(s, 18);
  } catch {
    return 0n;
  }
}

function parsePct(s: string): bigint {
  if (!s) return 0n;
  try {
    // Input is a percent string like "2" or "2.5" meaning 2% / 2.5%.
    // Convert to the 1e18-scaled fraction: 2 → 0.02e18 = 2e16.
    return parseUnits(s, 18) / 100n;
  } catch {
    return 0n;
  }
}

function parseIntSafe(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  const floored = Math.floor(n);
  return floored < 0 ? 0 : floored;
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

function formatPrice(value: bigint): string {
  return `${formatAmount(value)} ETX`;
}
