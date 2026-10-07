'use client';

import { useEffect, useMemo, useState } from 'react';
import { BaseError, UserRejectedRequestError, formatUnits, isAddress, type Address, type Hex } from 'viem';
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { USDC_WARP_ROUTE, isUsdcWarpRouteLive } from '@etica-hub/shared';
import {
  USDC_LEGS,
  parseUsdcAmount,
  splitWarpQuote,
  toBytes32Recipient,
  type UsdcDirection,
} from '@/lib/bridge/usdc-transfer';

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const warpAbi = [
  {
    type: 'function',
    name: 'quoteTransferRemote',
    stateMutability: 'view',
    inputs: [
      { name: 'destination', type: 'uint32' },
      { name: 'recipient', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [
      {
        type: 'tuple[]',
        components: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'transferRemote',
    stateMutability: 'payable',
    inputs: [
      { name: 'destination', type: 'uint32' },
      { name: 'recipient', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

const DECIMALS: number = USDC_WARP_ROUTE.decimals;

function fmt(value: bigint | undefined, decimals = DECIMALS, digits = 2): string {
  if (value === undefined) return '…';
  return Number(formatUnits(value, decimals)).toLocaleString('en-US', { maximumFractionDigits: digits });
}

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in the wallet.';
  if (err instanceof BaseError) return err.shortMessage;
  return err instanceof Error ? err.message : String(err);
}

type Stage = 'idle' | 'switching' | 'approving' | 'sending';

/**
 * Hyperlane warp transfer: Ethereum USDC ⇄ Etica USDC.e. The user signs
 * `transferRemote` on the source router (plus an ERC-20 approval on the
 * collateral side); the validator/relayer deliver the mint or release on
 * the other chain, typically within a few minutes.
 */
export function UsdcBridgeCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [direction, setDirection] = useState<UsdcDirection>('toEtica');
  const [amountInput, setAmountInput] = useState('');
  const [recipientInput, setRecipientInput] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [approveHash, setApproveHash] = useState<Hex | undefined>();
  const [sendHash, setSendHash] = useState<Hex | undefined>();

  const leg = USDC_LEGS[direction];
  const live = isUsdcWarpRouteLive();
  const onSourceChain = chainId === leg.sourceChainId;
  const amount = useMemo(() => parseUsdcAmount(amountInput), [amountInput]);
  const recipient: Address | null = recipientInput
    ? isAddress(recipientInput)
      ? recipientInput
      : null
    : (address ?? null);

  const balance = useReadContract({
    abi: erc20Abi,
    address: leg.token,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: leg.sourceChainId,
    query: { enabled: live && !!address },
  });
  const allowance = useReadContract({
    abi: erc20Abi,
    address: leg.token,
    functionName: 'allowance',
    args: address ? [address, leg.router] : undefined,
    chainId: leg.sourceChainId,
    query: { enabled: live && !!address && leg.needsApproval },
  });
  const native = useBalance({ address, chainId: leg.sourceChainId, query: { enabled: live && !!address } });
  const quote = useReadContract({
    abi: warpAbi,
    address: leg.router,
    functionName: 'quoteTransferRemote',
    args: amount && recipient ? [leg.destinationDomain, toBytes32Recipient(recipient), amount] : undefined,
    chainId: leg.sourceChainId,
    query: { enabled: live && !!amount && !!recipient },
  });

  const split = useMemo(() => {
    if (!quote.data || !amount) return null;
    try {
      return splitWarpQuote(quote.data, leg.token, amount);
    } catch (err) {
      return { error: shortError(err) };
    }
  }, [quote.data, amount, leg.token]);
  const quoted = split && !('error' in split) ? split : null;

  const approveReceipt = useWaitForTransactionReceipt({ hash: approveHash, chainId: leg.sourceChainId });
  const sendReceipt = useWaitForTransactionReceipt({ hash: sendHash, chainId: leg.sourceChainId });

  const refetchAllowance = allowance.refetch;
  const refetchBalance = balance.refetch;
  useEffect(() => {
    if (approveReceipt.isSuccess) void refetchAllowance();
  }, [approveReceipt.isSuccess, refetchAllowance]);
  useEffect(() => {
    if (sendReceipt.isSuccess) void refetchBalance();
  }, [sendReceipt.isSuccess, refetchBalance]);

  const total = amount && quoted ? amount + quoted.tokenFee : null;
  const needsApproval =
    leg.needsApproval && total !== null && allowance.data !== undefined && allowance.data < total;
  const insufficientToken = total !== null && balance.data !== undefined && balance.data < total;
  const insufficientNative =
    quoted !== null && native.data !== undefined && native.data.value < quoted.native;

  const blocker = !live
    ? 'The USDC.e route is not deployed.'
    : !isConnected || !address
      ? 'Connect a wallet to bridge.'
      : !amount
        ? 'Enter an amount.'
        : !recipient
          ? 'Recipient is not a valid address.'
          : split && 'error' in split
            ? split.error
            : quote.isError
              ? `Quote failed: ${shortError(quote.error)}`
              : insufficientToken
                ? `Not enough ${leg.tokenSymbol} for amount + fee.`
                : insufficientNative
                  ? `Not enough ${leg.nativeSymbol} for the delivery gas payment.`
                  : null;

  function flip() {
    setDirection((d) => (d === 'toEtica' ? 'toEthereum' : 'toEtica'));
    setApproveHash(undefined);
    setSendHash(undefined);
    setError(null);
  }

  async function submit() {
    if (!address || !amount || !recipient || !quoted || blocker) return;
    setError(null);
    try {
      if (!onSourceChain) {
        setStage('switching');
        await switchChainAsync({ chainId: leg.sourceChainId });
      }
      if (needsApproval && total !== null) {
        setStage('approving');
        const hash = await writeContractAsync({
          abi: erc20Abi,
          address: leg.token,
          functionName: 'approve',
          args: [leg.router, total],
          chainId: leg.sourceChainId,
        });
        setApproveHash(hash);
      }
      setStage('sending');
      const hash = await writeContractAsync({
        abi: warpAbi,
        address: leg.router,
        functionName: 'transferRemote',
        args: [leg.destinationDomain, toBytes32Recipient(recipient), amount],
        value: quoted.native,
        chainId: leg.sourceChainId,
      });
      setSendHash(hash);
    } catch (err) {
      setError(shortError(err));
    } finally {
      setStage('idle');
    }
  }

  const busy = stage !== 'idle';
  const label =
    stage === 'switching'
      ? `Switching to ${leg.sourceName}…`
      : stage === 'approving'
        ? `Approve ${leg.tokenSymbol} in wallet…`
        : stage === 'sending'
          ? 'Confirm transfer in wallet…'
          : !onSourceChain && isConnected
            ? `Switch to ${leg.sourceName} & bridge`
            : needsApproval
              ? `Approve & bridge to ${leg.destinationName}`
              : `Bridge to ${leg.destinationName}`;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-white/40">Transfer</div>
          <div className="mt-1 text-lg font-semibold text-white">
            {leg.tokenSymbol} on {leg.sourceName} → {direction === 'toEtica' ? 'USDC.e' : 'USDC'} on{' '}
            {leg.destinationName}
          </div>
        </div>
        <button
          type="button"
          onClick={flip}
          disabled={busy}
          className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 disabled:opacity-50"
        >
          ⇅ Flip direction
        </button>
      </div>

      <label className="mt-4 block text-xs text-white/50">
        Amount ({leg.tokenSymbol})
        <div className="mt-1 flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            disabled={busy}
            className="w-full bg-transparent font-mono text-base text-white outline-none placeholder:text-white/25"
          />
          <button
            type="button"
            disabled={busy || balance.data === undefined}
            onClick={() => balance.data !== undefined && setAmountInput(formatUnits(balance.data, DECIMALS))}
            className="text-xs text-fuchsia-200 hover:underline disabled:opacity-40"
          >
            max
          </button>
        </div>
        <div className="mt-1 text-[11px] text-white/40">
          Balance: {fmt(balance.data)} {leg.tokenSymbol} · {fmt(native.data?.value, 18, 4)} {leg.nativeSymbol}
        </div>
      </label>

      <label className="mt-3 block text-xs text-white/50">
        Recipient on {leg.destinationName}
        <input
          placeholder={address ?? '0x…'}
          value={recipientInput}
          onChange={(e) => setRecipientInput(e.target.value.trim())}
          disabled={busy}
          spellCheck={false}
          className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white outline-none placeholder:text-white/25"
        />
        <div className="mt-1 text-[11px] text-white/40">Defaults to the connected wallet.</div>
      </label>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs">
        <dt className="text-white/50">Bridge fee</dt>
        <dd className="text-right font-mono text-white/85">
          {amount ? `${fmt(quoted?.tokenFee)} ${leg.tokenSymbol}` : '—'}
        </dd>
        <dt className="text-white/50">Delivery gas payment</dt>
        <dd className="text-right font-mono text-white/85">
          {amount ? `${fmt(quoted?.native, 18, 6)} ${leg.nativeSymbol}` : '—'}
        </dd>
        <dt className="text-white/50">Recipient receives</dt>
        <dd className="text-right font-mono text-white">
          {amount ? `${fmt(amount)} ${direction === 'toEtica' ? 'USDC.e' : 'USDC'}` : '—'}
        </dd>
        <dt className="text-white/50">Total debited</dt>
        <dd className="text-right font-mono text-white/85">
          {total !== null ? `${fmt(total)} ${leg.tokenSymbol}` : '—'}
        </dd>
      </dl>
      <div className="mt-2 text-[11px] text-white/40">{leg.feeNote}. Delivery usually lands within a few minutes.</div>

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || !!blocker}
        className="mt-4 w-full rounded-lg bg-brand-accent px-4 py-2.5 text-sm font-medium text-brand-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {label}
      </button>
      {blocker && isConnected && amountInput && <div className="mt-2 text-xs text-amber-300/80">{blocker}</div>}
      {error && <div className="mt-2 text-xs text-rose-300">{error}</div>}

      {approveHash && (
        <TxLine label={`Approval ${approveReceipt.isSuccess ? 'confirmed' : 'pending'}`} href={leg.explorerTx(approveHash)} hash={approveHash} />
      )}
      {sendHash && (
        <TxLine
          label={
            sendReceipt.isSuccess
              ? `Sent on ${leg.sourceName} — the relayer delivers to ${leg.destinationName} in a few minutes`
              : sendReceipt.isError
                ? 'Transfer reverted'
                : `Transfer pending on ${leg.sourceName}`
          }
          href={leg.explorerTx(sendHash)}
          hash={sendHash}
        />
      )}
    </div>
  );
}

function TxLine({ label, href, hash }: { label: string; href: string; hash: Hex }) {
  return (
    <div className="mt-2 text-xs text-white/60">
      {label}:{' '}
      <a href={href} target="_blank" rel="noreferrer" className="font-mono text-fuchsia-200 hover:underline">
        {hash.slice(0, 10)}…{hash.slice(-6)}
      </a>
    </div>
  );
}
