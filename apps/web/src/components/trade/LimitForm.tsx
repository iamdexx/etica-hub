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
  buildLimitOrder,
  buildPermit2WitnessTypedData,
  encodeDutchOrder,
  randomPermit2Nonce,
  type Side,
} from '@/lib/trading/dutchOrder';
import { resolveOrderbookUrl, submitOrder, OrderbookError } from '@/lib/trading/orderbookClient';

type BaseSymbol = 'ETI' | 'EGAZ';

export interface LimitFormProps {
  baseSymbol: BaseSymbol;
}

const DEFAULT_EXPIRY_HOURS = 24;
const MIN_DEADLINE_BUFFER_SEC = 5 * 60;

export function LimitForm({ baseSymbol }: LimitFormProps) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const orderbookUrl = resolveOrderbookUrl();

  const [side, setSide] = useState<Side>('buy');
  const [amountStr, setAmountStr] = useState('');
  const [priceStr, setPriceStr] = useState('');
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
    Boolean(orderbookUrl) &&
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
    if (!tradingLive || !orderbookUrl) {
      setError('Trading stack is pending deployment — orders can be signed once the reactor is live.');
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
      setStatusLine('Submitting to order book…');
      const stored = await submitOrder(orderbookUrl, { encodedOrder: encoded, signature });
      setStatusLine(`Order ${shortHash(stored.orderHash)} submitted. Keepers will fill it when price is reached.`);
      setAmountStr('');
      setPriceStr('');
      resetWrite();
    } catch (err) {
      setStatusLine(null);
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const quoteAmount = amount > 0n && pricePerBase18 > 0n ? (amount * pricePerBase18) / 10n ** 18n : 0n;

  return (
    <div className="space-y-3">
      {!tradingLive ? (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4 text-xs">
          <div className="mb-1 uppercase tracking-wider text-amber-200/80">Beta — reactor not yet deployed</div>
          <p className="text-white/70">
            You can compose a limit order, but signing is disabled until the UniswapX reactor is live on
            Etica mainnet. Once deployed, the form below will become active with no UI changes.
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
            {s === 'buy' ? `Buy ${baseSymbol}` : `Sell ${baseSymbol}`}
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

      <label className="block space-y-1 text-xs">
        <span className="text-white/60">Limit price (ETX per {baseSymbol})</span>
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
        {side === 'buy' ? (
          <>Spend up to <span className="text-white/90">{formatAmount(quoteAmount)} ETX</span> for {formatAmount(amount)} {baseSymbol}</>
        ) : (
          <>Sell {formatAmount(amount)} {baseSymbol} for at least <span className="text-white/90">{formatAmount(quoteAmount)} ETX</span></>
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
        disabled={!isConnected || !tradingLive || submitting || needsPermit2Approval || amount <= 0n || pricePerBase18 <= 0n}
        className="w-full rounded-xl bg-brand-accent px-3 py-2 text-sm font-medium text-brand-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Signing…' : `Sign ${side === 'buy' ? 'buy' : 'sell'} limit order`}
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
