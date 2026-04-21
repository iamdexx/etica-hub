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
  buildLimitOrder,
  buildPermit2WitnessTypedData,
  encodeDutchOrder,
  randomPermit2Nonce,
  type Side,
} from '@/lib/trading/dutchOrder';
import {
  resolveOrderbookUrl,
  submitOrder,
  OrderbookError,
  type StrategyType,
  type TriggerDirection,
} from '@/lib/trading/orderbookClient';
import {
  buildLimitMeta,
  buildStopMeta,
  getRegistryAddress,
  postOrderOnChain,
} from '@/lib/trading/registryClient';

type BaseSymbol = 'ETI' | 'EGAZ';

export interface OrderFormProps {
  baseSymbol: BaseSymbol;
  /**
   * `limit` renders the legacy limit form (amount + limit price).
   * `stop` adds a "trigger price" input; the order is only attempted by a
   * keeper once price crosses the trigger in the direction implied by `side`
   * (sell → stop-loss = trigger-price-or-lower, buy → buy-stop = trigger-or-higher).
   */
  strategy: StrategyType;
}

const DEFAULT_EXPIRY_HOURS = 24;
const MIN_DEADLINE_BUFFER_SEC = 5 * 60;

export function OrderForm({ baseSymbol, strategy }: OrderFormProps) {
  const isStop = strategy === 'stop';
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const orderbookUrl = resolveOrderbookUrl();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const registryAddress = getRegistryAddress(chainId);

  // Stop orders default to `sell` because stop-loss is the overwhelmingly
  // common case; limit orders default to `buy` to match the prior form.
  const [side, setSide] = useState<Side>(isStop ? 'sell' : 'buy');
  const [amountStr, setAmountStr] = useState('');
  const [priceStr, setPriceStr] = useState('');
  const [triggerStr, setTriggerStr] = useState('');
  const [expiryHours, setExpiryHours] = useState(DEFAULT_EXPIRY_HOURS);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const supported = isSupportedChainId(chainId);
  const deployment = supported ? DEPLOYMENTS[chainId] : null;
  const ext = supported ? EXTERNAL_ADDRESSES[chainId] : null;
  const permit2 = deployment?.permit2 ?? '0x0000000000000000000000000000000000000000';
  const reactor = deployment?.dutchReactor ?? '0x0000000000000000000000000000000000000000';
  const etxToken = deployment?.etx ?? '0x0000000000000000000000000000000000000000';
  const baseToken: Address =
    baseSymbol === 'ETI'
      ? (ext?.eti ?? '0x0000000000000000000000000000000000000000')
      : (deployment?.wegaz ?? '0x0000000000000000000000000000000000000000');

  const tradingLive =
    (Boolean(orderbookUrl) || registryAddress !== null) &&
    permit2 !== '0x0000000000000000000000000000000000000000' &&
    reactor !== '0x0000000000000000000000000000000000000000';

  const amount = useMemo(() => {
    if (!amountStr) return 0n;
    try {
      return parseUnits(amountStr, 18);
    } catch {
      return 0n;
    }
  }, [amountStr]);

  const pricePerBase18 = useMemo(() => {
    if (!priceStr) return 0n;
    try {
      return parseUnits(priceStr, 18);
    } catch {
      return 0n;
    }
  }, [priceStr]);

  const triggerPrice18 = useMemo(() => {
    if (!isStop || !triggerStr) return 0n;
    try {
      return parseUnits(triggerStr, 18);
    } catch {
      return 0n;
    }
  }, [isStop, triggerStr]);

  const triggerDirection: TriggerDirection = side === 'sell' ? 'lte' : 'gte';

  const inputToken = side === 'sell' ? baseToken : etxToken;

  const allowance = useReadContract({
    abi: abis.erc20Abi,
    address: inputToken,
    functionName: 'allowance',
    args:
      address && permit2 !== '0x0000000000000000000000000000000000000000'
        ? [address, permit2]
        : undefined,
    query: {
      enabled: Boolean(
        address && inputToken !== '0x0000000000000000000000000000000000000000' && tradingLive,
      ),
    },
  });

  // Input-side amount the user must have approved to Permit2. For sells the
  // input is the base token (`amount`); for buys the input is ETX, priced as
  // `amount * pricePerBase / 1e18`. If we compared against `amount` for buys
  // we'd let price > 1 bypass the approval gate — the reactor would then fail
  // to pull enough ETX at fill time.
  const inputAmountNeeded =
    side === 'sell'
      ? amount
      : amount > 0n && pricePerBase18 > 0n
        ? (amount * pricePerBase18) / 10n ** 18n
        : 0n;
  const needsPermit2Approval =
    tradingLive &&
    inputAmountNeeded > 0n &&
    ((allowance.data as bigint | undefined) ?? 0n) < inputAmountNeeded;

  const { writeContractAsync, data: approveTxHash, reset: resetWrite } = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({
    hash: approveTxHash,
    query: { enabled: Boolean(approveTxHash) },
  });
  const { signTypedDataAsync } = useSignTypedData();

  const isApproving = Boolean(approveTxHash) && !approveReceipt.data && !approveReceipt.error;

  // Once the approve tx mines, wagmi's cached allowance read is stale — force
  // a refetch so `needsPermit2Approval` flips to false and the sign button
  // unlocks without a page reload. Matches the pattern in SwapCard.
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
    if (!address || !isConnected) {
      setError('Connect a wallet first.');
      return;
    }
    if (!tradingLive) {
      setError('Order book + keeper are still deploying — orders can be signed once they are online.');
      return;
    }
    if (registryAddress && (!walletClient || !publicClient)) {
      setError('Wallet session still loading — try again in a moment.');
      return;
    }
    if (amount <= 0n) {
      setError('Amount must be greater than zero.');
      return;
    }
    if (pricePerBase18 <= 0n) {
      setError('Limit price must be greater than zero.');
      return;
    }
    if (isStop) {
      if (triggerPrice18 <= 0n) {
        setError('Trigger price must be greater than zero.');
        return;
      }
      // Sanity: the keeper will only fire the fill once price crosses the
      // trigger, so the limit price has to be reachable from the trigger.
      // Stop-loss: fill price must be ≤ trigger (keeper executes on dip).
      // Buy-stop: fill price must be ≥ trigger (keeper executes on rip).
      if (side === 'sell' && pricePerBase18 > triggerPrice18) {
        setError('Stop-loss limit must be ≤ trigger price.');
        return;
      }
      if (side === 'buy' && pricePerBase18 < triggerPrice18) {
        setError('Buy-stop limit must be ≥ trigger price.');
        return;
      }
    }
    const deadlineSec = Math.floor(Date.now() / 1000) + expiryHours * 3600;
    if (deadlineSec < Math.floor(Date.now() / 1000) + MIN_DEADLINE_BUFFER_SEC) {
      setError('Expiry is too close to now.');
      return;
    }
    if (needsPermit2Approval) {
      setError('Approve Permit2 before signing the order.');
      return;
    }
    setSubmitting(true);
    try {
      const order = buildLimitOrder({
        reactor: reactor as Address,
        swapper: address,
        side,
        baseToken,
        quoteToken: etxToken as Address,
        baseAmount: amount,
        pricePerBase18,
        baseDecimals: 18,
        quoteDecimals: 18,
        deadlineSec,
        nonce: randomPermit2Nonce(),
      });
      const encoded = encodeDutchOrder(order);
      const typed = buildPermit2WitnessTypedData(order, {
        chainId,
        permit2: permit2 as Address,
      });
      setStatusLine('Waiting for wallet signature…');
      const signature = (await signTypedDataAsync({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      })) as Hex;
      let orderHash: Hex;
      if (registryAddress && walletClient && publicClient && supported) {
        setStatusLine('Posting order on-chain…');
        const meta = isStop
          ? buildStopMeta({ triggerPrice: triggerPrice18, direction: triggerDirection })
          : buildLimitMeta();
        const { orderHash: hash, txHash } = await postOrderOnChain({
          walletClient,
          publicClient,
          chainId: chainId as SupportedChainId,
          account: address,
          encodedOrder: encoded,
          signature,
          meta,
        });
        orderHash = hash;
        setStatusLine(`Waiting for registry tx ${shortHash(txHash)}…`);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== 'success') {
          throw new Error('Registry tx reverted on-chain');
        }
      } else if (orderbookUrl) {
        setStatusLine('Submitting to order book…');
        const stored = await submitOrder(orderbookUrl, {
          encodedOrder: encoded,
          signature,
          ...(isStop
            ? {
                strategyType: 'stop' as const,
                triggerPrice: triggerPrice18.toString(),
                triggerDirection,
              }
            : {}),
        });
        orderHash = stored.orderHash;
      } else {
        throw new Error('No registry or orderbook available');
      }
      setStatusLine(
        isStop
          ? `Stop ${shortHash(orderHash)} armed. Keeper will fill when price ${
              triggerDirection === 'lte' ? '≤' : '≥'
            } ${triggerStr} ETX.`
          : `Order ${shortHash(orderHash)} submitted. Keepers will fill it when price is reached.`,
      );
      setAmountStr('');
      setPriceStr('');
      if (isStop) setTriggerStr('');
      resetWrite();
    } catch (err) {
      setStatusLine(null);
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const quoteAmount = amount > 0n && pricePerBase18 > 0n ? (amount * pricePerBase18) / 10n ** 18n : 0n;

  const stopCopy = isStop
    ? side === 'sell'
      ? `Sell ${formatAmount(amount)} ${baseSymbol} if price drops to ${triggerStr || '…'} ETX (fill at ≥ ${
          priceStr || '…'
        } ETX/${baseSymbol})`
      : `Buy ${formatAmount(amount)} ${baseSymbol} if price rises to ${triggerStr || '…'} ETX (fill at ≤ ${
          priceStr || '…'
        } ETX/${baseSymbol})`
    : null;

  return (
    <div className="space-y-3">
      {!tradingLive ? (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4 text-xs">
          <div className="mb-1 uppercase tracking-wider text-amber-200/80">
            Coming soon — order book + keeper deploying
          </div>
          <p className="text-white/70">
            The UniswapX reactor is live on Etica mainnet, but the order book and reference keeper
            are not yet online. You can configure {isStop ? 'a stop' : 'a limit'} order below,
            but Sign stays disabled until orders can be routed to a keeper. No UI changes once it goes live.
          </p>
        </div>
      ) : null}

      <div className="flex gap-1 rounded-full border border-white/10 bg-white/5 p-1">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={`flex-1 rounded-full px-3 py-1.5 text-xs uppercase tracking-wider transition-colors ${
              s === side
                ? s === 'buy'
                  ? 'bg-emerald-400 text-brand-ink'
                  : 'bg-rose-400 text-brand-ink'
                : 'text-white/70 hover:bg-white/5 hover:text-white'
            }`}
          >
            {isStop
              ? s === 'buy'
                ? `Buy-stop ${baseSymbol}`
                : `Stop-loss ${baseSymbol}`
              : s === 'buy'
                ? `Buy ${baseSymbol}`
                : `Sell ${baseSymbol}`}
          </button>
        ))}
      </div>

      <label className="block space-y-1 text-xs">
        <span className="text-white/60">Amount ({baseSymbol})</span>
        <input
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value)}
          placeholder="0.0"
          inputMode="decimal"
          className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-brand-accent/60"
        />
      </label>

      {isStop ? (
        <label className="block space-y-1 text-xs">
          <span className="text-white/60">
            Trigger price (ETX per {baseSymbol}) —{' '}
            {side === 'sell' ? 'fires when price drops to' : 'fires when price rises to'}
          </span>
          <input
            value={triggerStr}
            onChange={(e) => setTriggerStr(e.target.value)}
            placeholder="0.0"
            inputMode="decimal"
            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-brand-accent/60"
          />
        </label>
      ) : null}

      <label className="block space-y-1 text-xs">
        <span className="text-white/60">
          {isStop ? 'Worst fill price' : 'Limit price'} (ETX per {baseSymbol})
        </span>
        <input
          value={priceStr}
          onChange={(e) => setPriceStr(e.target.value)}
          placeholder="0.0"
          inputMode="decimal"
          className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-brand-accent/60"
        />
      </label>

      <label className="block space-y-1 text-xs">
        <span className="text-white/60">Expires in</span>
        <select
          value={expiryHours}
          onChange={(e) => setExpiryHours(Number(e.target.value))}
          className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-brand-accent/60"
        >
          <option value={1}>1 hour</option>
          <option value={6}>6 hours</option>
          <option value={24}>1 day</option>
          <option value={72}>3 days</option>
          <option value={168}>1 week</option>
        </select>
      </label>

      <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 text-xs text-white/60">
        {isStop ? (
          stopCopy
        ) : side === 'buy' ? (
          <>
            Spend up to <span className="text-white/90">{formatAmount(quoteAmount)} ETX</span> for{' '}
            {formatAmount(amount)} {baseSymbol}
          </>
        ) : (
          <>
            Sell {formatAmount(amount)} {baseSymbol} for at least{' '}
            <span className="text-white/90">{formatAmount(quoteAmount)} ETX</span>
          </>
        )}
      </div>

      {needsPermit2Approval ? (
        <button
          type="button"
          onClick={onApprovePermit2}
          disabled={isApproving}
          className="w-full rounded-xl bg-white/10 px-3 py-2 text-sm text-white transition-colors hover:bg-white/15 disabled:opacity-50"
        >
          {isApproving ? 'Approving Permit2…' : `Approve Permit2 for ${side === 'buy' ? 'ETX' : baseSymbol}`}
        </button>
      ) : null}

      <button
        type="button"
        onClick={onSign}
        disabled={
          !isConnected ||
          !tradingLive ||
          submitting ||
          needsPermit2Approval ||
          amount <= 0n ||
          pricePerBase18 <= 0n ||
          (isStop && triggerPrice18 <= 0n)
        }
        className="w-full rounded-xl bg-brand-accent px-3 py-2 text-sm font-medium text-brand-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting
          ? 'Signing…'
          : isStop
            ? `Arm ${side === 'sell' ? 'stop-loss' : 'buy-stop'}`
            : `Sign ${side === 'buy' ? 'buy' : 'sell'} limit order`}
      </button>

      {statusLine ? <div className="text-xs text-emerald-300/80">{statusLine}</div> : null}
      {error ? <div className="text-xs text-rose-300">{error}</div> : null}
    </div>
  );
}

function shortHash(hex: Hex): string {
  return `${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

function formatAmount(x: bigint): string {
  if (x === 0n) return '0';
  const s = formatUnits(x, 18);
  const num = Number(s);
  if (!Number.isFinite(num)) return s;
  return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function formatError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Signature rejected.';
  if (err instanceof OrderbookError) return `Order book rejected order: ${err.message}`;
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
