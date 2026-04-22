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
  abis,
  isSupportedChainId,
  type SupportedChainId,
} from '@etica-hub/shared';
import {
  buildGridLegs,
  buildPermit2WitnessTypedData,
  encodeDutchOrder,
  randomGridBatchId,
  type GridLevel,
} from '@/lib/trading/dutchOrder';
import { resolveOrderbookUrl, submitOrder } from '@/lib/trading/orderbookClient';
import {
  buildGridMeta,
  getRegistryAddress,
  postOrderBatchOnChain,
  toBatchIdBytes32,
} from '@/lib/trading/registryClient';

import {
  resolveBaseTokenAddress,
  type TradeBaseSymbol,
} from '@/lib/trading/baseSymbol';

type BaseSymbol = TradeBaseSymbol;

export interface GridFormProps {
  baseSymbol: BaseSymbol;
}

const ZERO: Address = '0x0000000000000000000000000000000000000000';

// Grid stays active for 7 days by default. Long enough to catch realistic
// range-bound cycles; user can cancel individual levels via the orders
// dashboard or re-sign a fresh grid.
const GRID_VALIDITY_SEC = 7 * 24 * 60 * 60;

export function GridForm({ baseSymbol }: GridFormProps) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const orderbookUrl = resolveOrderbookUrl();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const registryAddress = getRegistryAddress(chainId);

  const [lowStr, setLowStr] = useState('');
  const [highStr, setHighStr] = useState('');
  const [refPriceStr, setRefPriceStr] = useState('');
  const [levelsStr, setLevelsStr] = useState('8');
  const [basePerLevelStr, setBasePerLevelStr] = useState('');
  const [progress, setProgress] = useState<{ signed: number; total: number } | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const supported = isSupportedChainId(chainId);
  const deployment = supported ? DEPLOYMENTS[chainId] : null;
  const permit2 = deployment?.permit2 ?? ZERO;
  const reactor = deployment?.dutchReactor ?? ZERO;
  const etxToken = deployment?.etx ?? ZERO;
  const baseToken: Address = resolveBaseTokenAddress(chainId, baseSymbol);

  const tradingLive =
    (Boolean(orderbookUrl) || registryAddress !== null) && permit2 !== ZERO && reactor !== ZERO;

  const lowPrice18 = useMemo(() => parseDecimal(lowStr), [lowStr]);
  const highPrice18 = useMemo(() => parseDecimal(highStr), [highStr]);
  const refPrice18 = useMemo(() => parseDecimal(refPriceStr), [refPriceStr]);
  const basePerLevel = useMemo(() => parseDecimal(basePerLevelStr), [basePerLevelStr]);

  const levels = useMemo(() => {
    const n = Number(levelsStr);
    if (!Number.isFinite(n)) return 0;
    return Math.floor(n);
  }, [levelsStr]);

  // Preview the level layout so the user can sanity-check before signing.
  // `buildGridLegs` validates the inputs; we just render whatever it hands
  // back, or fall through to a nullable preview if inputs aren't ready.
  const plan: GridLevel[] | null = useMemo(() => {
    if (!address || reactor === ZERO || baseToken === ZERO || etxToken === ZERO) return null;
    if (lowPrice18 <= 0n || highPrice18 <= lowPrice18) return null;
    if (refPrice18 <= lowPrice18 || refPrice18 >= highPrice18) return null;
    if (basePerLevel <= 0n) return null;
    if (levels < 2 || levels > 50) return null;
    const startSec = Math.floor(Date.now() / 1000);
    try {
      return buildGridLegs({
        reactor: reactor as Address,
        swapper: address,
        baseToken,
        quoteToken: etxToken as Address,
        baseDecimals: 18,
        quoteDecimals: 18,
        lowPrice18,
        highPrice18,
        referencePrice18: refPrice18,
        levels,
        baseAmountPerLevel: basePerLevel,
        startSec,
        deadlineSec: startSec + GRID_VALIDITY_SEC,
        // deterministic nonces for the preview so the memo isn't invalidated
        // every render; real signing path below regenerates the plan with
        // live random nonces.
        nonceGenerator: (() => {
          let i = 1n;
          return () => i++;
        })(),
      });
    } catch {
      return null;
    }
  }, [address, reactor, baseToken, etxToken, lowPrice18, highPrice18, refPrice18, basePerLevel, levels]);

  const buyLevels = useMemo(
    () => plan?.filter((l) => l.side === 'buy') ?? [],
    [plan],
  );
  const sellLevels = useMemo(
    () => plan?.filter((l) => l.side === 'sell') ?? [],
    [plan],
  );

  // For approvals + preview copy: buy side spends ETX, sell side spends base.
  // We need both allowances because the grid contains orders on both sides
  // unless the reference price is at an extreme edge.
  const totalEtxInput = useMemo(() => {
    let sum = 0n;
    for (const lvl of buyLevels) {
      sum += (basePerLevel * lvl.pricePerBase18) / 10n ** 18n;
    }
    return sum;
  }, [buyLevels, basePerLevel]);
  const totalBaseInput = BigInt(sellLevels.length) * basePerLevel;

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

  // After a successful Permit2 approval the on-chain allowance changed, but
  // TanStack Query would otherwise keep the cached pre-approval value until
  // its next stale-time refetch. Without this effect the Sign button stays
  // disabled even though the approval landed — same pattern DcaForm and
  // OrderForm use for their single allowance.
  useEffect(() => {
    if (approveReceipt.isSuccess) {
      void etxAllowance.refetch();
      void baseAllowance.refetch();
    }
    // Intentionally depends only on the boolean flag — refetch identities are
    // stable across renders and TanStack Query memoizes the closures.
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
    if (!tradingLive) {
      setError(
        'Order book + keeper are still deploying — grids can be signed once they are online.',
      );
      return;
    }
    if (registryAddress && (!walletClient || !publicClient)) {
      setError('Wallet session still loading — try again in a moment.');
      return;
    }
    if (lowPrice18 <= 0n || highPrice18 <= lowPrice18) {
      setError('Low and high prices must be positive, with high > low.');
      return;
    }
    if (refPrice18 <= lowPrice18 || refPrice18 >= highPrice18) {
      setError('Reference price must sit strictly between low and high.');
      return;
    }
    if (basePerLevel <= 0n) {
      setError(`${baseSymbol} per level must be greater than zero.`);
      return;
    }
    if (levels < 2 || levels > 50) {
      setError('Levels must be between 2 and 50.');
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
      legs = buildGridLegs({
        reactor: reactor as Address,
        swapper: address,
        baseToken,
        quoteToken: etxToken as Address,
        baseDecimals: 18,
        quoteDecimals: 18,
        lowPrice18,
        highPrice18,
        referencePrice18: refPrice18,
        levels,
        baseAmountPerLevel: basePerLevel,
        startSec,
        deadlineSec: startSec + GRID_VALIDITY_SEC,
      });
    } catch (err) {
      setError(formatError(err));
      return;
    }

    if (legs.length === 0) {
      setError('Grid produced zero fillable levels — widen the bounds.');
      return;
    }

    setSubmitting(true);
    setProgress({ signed: 0, total: legs.length });
    try {
      const useRegistry = Boolean(registryAddress && walletClient && publicClient && supported);
      const encodedByLevel: Hex[] = [];
      const signatureByLevel: Hex[] = [];
      for (let i = 0; i < legs.length; i += 1) {
        const lvl = legs[i];
        setStatusLine(
          `Waiting for signature ${i + 1} of ${legs.length} (level ${lvl.index + 1} @ ${formatPrice(lvl.pricePerBase18)})…`,
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
        encodedByLevel.push(encoded);
        signatureByLevel.push(signature);
        setProgress({ signed: i + 1, total: legs.length });

        if (!useRegistry) {
          setStatusLine(`Submitting level ${i + 1} of ${legs.length}…`);
          await submitOrder(orderbookUrl!, {
            encodedOrder: encoded,
            signature,
            strategyType: 'grid',
            gridBatchId: batchId,
            gridIndex: lvl.index,
            gridTotal: legs.length,
            gridLevelPrice: lvl.pricePerBase18.toString(),
          });
        }
      }

      if (useRegistry && walletClient && publicClient) {
        setStatusLine(`Posting ${legs.length} levels on-chain in one tx…`);
        const batchIdBytes = toBatchIdBytes32(batchId);
        const metas = legs.map((lvl) =>
          buildGridMeta({
            batchId: batchIdBytes,
            indexInBatch: lvl.index,
            totalInBatch: legs.length,
            levelPrice: lvl.pricePerBase18,
          }),
        );
        const { txHash } = await postOrderBatchOnChain({
          walletClient,
          publicClient,
          chainId: chainId as SupportedChainId,
          account: address,
          encodedOrders: encodedByLevel,
          signatures: signatureByLevel,
          metas,
        });
        setStatusLine(`Waiting for registry tx ${shortHash(txHash)}…`);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== 'success') {
          throw new Error('Registry batch tx reverted on-chain');
        }
      }

      setStatusLine(
        `Grid submitted (${legs.length} levels, batch ${batchId.slice(0, 8)}…). Keeper will fill whichever side the market crosses.`,
      );
      setLowStr('');
      setHighStr('');
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
        <div className="mb-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-white/60">
              Low price (ETX per {baseSymbol})
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={lowStr}
              onChange={(e) => setLowStr(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-white/60">
              High price (ETX per {baseSymbol})
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={highStr}
              onChange={(e) => setHighStr(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-accent"
            />
          </label>
        </div>

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
            Levels below this price become buys, levels above become sells.
          </span>
        </label>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-white/60">
              Levels (2–50)
            </span>
            <input
              type="number"
              min={2}
              max={50}
              value={levelsStr}
              onChange={(e) => setLevelsStr(e.target.value)}
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

        {plan ? (
          <p className="mb-3 rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-white/70">
            {buyLevels.length} buy level{buyLevels.length === 1 ? '' : 's'} · {sellLevels.length} sell level
            {sellLevels.length === 1 ? '' : 's'} — commits up to{' '}
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
            ? progress && progress.signed < progress.total
              ? `Signing ${progress.signed + 1} of ${progress.total}…`
              : 'Submitting…'
            : `Sign ${plan?.length ?? 0}-level grid`}
        </button>

        {statusLine ? <p className="mt-3 text-xs text-white/70">{statusLine}</p> : null}
        {error ? <p className="mt-3 text-xs text-rose-300">{error}</p> : null}
      </div>

      <p className="text-xs text-white/50">
        Grid levels are individual pre-signed limit orders — your funds stay in your wallet
        until the keeper lands a fill at a crossed level. Cancel any level individually from
        the orders dashboard.
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

function shortHash(hex: Hex): string {
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}
