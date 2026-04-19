'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import {
  useAccount,
  useChainId,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import {
  BRIDGE_ETHEREUM_DEPLOYMENTS,
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  abis,
  isSupportedChainId,
} from '@etica-hub/shared';

/**
 * Bridge flow, both directions:
 *
 *   Etica → Ethereum:
 *     1. Approve ETI → vault
 *     2. vault.deposit(amount, recipient)           ← emits Deposited(nonce)
 *     3. (relayer validators sign; coordinator aggregates)
 *     4. minter.mint(srcChainId, srcTxHash, nonce, amount, recipient, signatures)
 *
 *   Ethereum → Etica:
 *     1. Approve wETI → minter
 *     2. minter.burn(amount, recipient)             ← emits Burned(nonce)
 *     3. (validators sign)
 *     4. vault.withdraw(srcChainId, srcTxHash, nonce, amount, recipient, signatures)
 *
 * The UI hides the cross-chain complexity behind one card with a direction
 * toggle. Step 4 is submitted manually by the user on the destination chain
 * (they switch networks in their wallet, UI picks it up); in a future
 * revision an automatic relayer could run step 4 for them.
 */

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Destination chain lookup. Deliberately explicit rather than "always
 * mainnet" so a user on Etica Crucible testnet can bridge to Sepolia,
 * and a user on Sepolia can bridge back to Crucible — not to Ethereum
 * mainnet or Etica mainnet. Local anvil fork (31337) also routes to
 * Sepolia since there's no paired local Ethereum devnet in this repo.
 */
const ETICA_TO_ETH_DST: Record<number, number> = {
  61803: 1,
  61888: 11155111,
  31337: 11155111,
};
const ETH_TO_ETICA_DST: Record<number, number> = {
  1: 61803,
  11155111: 61888,
};

type BridgeDirection = 'etica-to-eth' | 'eth-to-etica';
type TxType = 'approve' | 'lock';

type BridgeCtx = {
  direction: BridgeDirection;
  srcChainId: number;
  dstChainId: number;
  srcTokenLabel: string;
  dstTokenLabel: string;
  srcToken: Address;
  srcContract: Address;
  dstContract: Address;
};

function useBridgeCtx(direction: BridgeDirection): BridgeCtx | null {
  const chainId = useChainId();
  return useMemo(() => {
    if (direction === 'etica-to-eth') {
      if (!isSupportedChainId(chainId)) return null;
      const d = DEPLOYMENTS[chainId];
      if (d.bridgeVault === ZERO) return null;
      const dstChainId = ETICA_TO_ETH_DST[chainId];
      const ethAddrs = dstChainId ? BRIDGE_ETHEREUM_DEPLOYMENTS[dstChainId] : undefined;
      if (!ethAddrs) return null;
      return {
        direction,
        srcChainId: chainId,
        dstChainId,
        srcTokenLabel: 'ETI',
        dstTokenLabel: 'wETI',
        srcToken: EXTERNAL_ADDRESSES[chainId].eti,
        srcContract: d.bridgeVault,
        dstContract: ethAddrs.bridgeMinter,
      };
    }
    // eth-to-etica: connected wallet should be on Ethereum (mainnet or Sepolia).
    const dstChainId = ETH_TO_ETICA_DST[chainId];
    if (!dstChainId) return null;
    const ethAddrs = BRIDGE_ETHEREUM_DEPLOYMENTS[chainId];
    if (!ethAddrs || ethAddrs.bridgeMinter === ZERO) return null;
    const dstDeployment = isSupportedChainId(dstChainId) ? DEPLOYMENTS[dstChainId] : undefined;
    if (!dstDeployment) return null;
    return {
      direction,
      srcChainId: chainId,
      dstChainId,
      srcTokenLabel: 'wETI',
      dstTokenLabel: 'ETI',
      srcToken: ethAddrs.weti,
      srcContract: ethAddrs.bridgeMinter,
      dstContract: dstDeployment.bridgeVault,
    };
  }, [chainId, direction]);
}

export function BridgeCard() {
  const [direction, setDirection] = useState<BridgeDirection>('etica-to-eth');
  const { address, isConnected } = useAccount();
  const ctx = useBridgeCtx(direction);

  const [amountStr, setAmountStr] = useState('');
  const [recipient, setRecipient] = useState<string>('');

  const amount = useMemo(() => {
    if (!amountStr) return 0n;
    try {
      return parseUnits(amountStr, 18);
    } catch {
      return 0n;
    }
  }, [amountStr]);

  useEffect(() => {
    // Default recipient to the connected address when it changes.
    if (address && !recipient) setRecipient(address);
  }, [address, recipient]);

  const srcBalance = useReadContract({
    abi: abis.erc20Abi,
    address: ctx?.srcToken,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && ctx) },
  });

  const allowance = useReadContract({
    abi: abis.erc20Abi,
    address: ctx?.srcToken,
    functionName: 'allowance',
    args: address && ctx ? [address, ctx.srcContract] : undefined,
    query: { enabled: Boolean(address && ctx) },
  });

  const srcBal = (srcBalance.data as bigint | undefined) ?? 0n;
  const needsApproval = amount > 0n && ((allowance.data as bigint | undefined) ?? 0n) < amount;
  const hasEnoughBalance = srcBal >= amount;
  const validRecipient = recipient.length === 42 && recipient.startsWith('0x');

  const {
    writeContractAsync,
    data: txHash,
    isPending: isTxPending,
    reset: resetWrite,
  } = useWriteContract();
  const [pendingTxHash, setPendingTxHash] = useState<Hex | undefined>();
  const [lastTxType, setLastTxType] = useState<TxType | undefined>();
  const [submitError, setSubmitError] = useState<string | undefined>();
  const activeHash = pendingTxHash ?? txHash;
  const receipt = useWaitForTransactionReceipt({
    hash: activeHash,
    query: { enabled: Boolean(activeHash) },
  });

  async function onApprove() {
    if (!ctx || !address || amount === 0n) return;
    setSubmitError(undefined);
    setPendingTxHash(undefined);
    setLastTxType(undefined);
    resetWrite();
    try {
      const hash = await writeContractAsync({
        abi: abis.erc20Abi,
        address: ctx.srcToken,
        functionName: 'approve',
        args: [ctx.srcContract, MAX_UINT256],
      });
      setLastTxType('approve');
      setPendingTxHash(hash);
    } catch (err) {
      setSubmitError(describeWriteError(err, 'Approval failed'));
    }
  }

  async function onLock() {
    if (!ctx || !address || amount === 0n || !validRecipient) return;
    setSubmitError(undefined);
    setPendingTxHash(undefined);
    setLastTxType(undefined);
    resetWrite();
    try {
      let hash: Hex;
      if (ctx.direction === 'etica-to-eth') {
        hash = await writeContractAsync({
          abi: abis.eticaBridgeVaultAbi,
          address: ctx.srcContract,
          functionName: 'deposit',
          args: [amount, recipient as Address],
        });
      } else {
        hash = await writeContractAsync({
          abi: abis.ethereumBridgeMinterAbi,
          address: ctx.srcContract,
          functionName: 'burn',
          args: [amount, recipient as Address],
        });
      }
      setLastTxType('lock');
      setPendingTxHash(hash);
    } catch (err) {
      setSubmitError(
        describeWriteError(
          err,
          ctx.direction === 'etica-to-eth' ? 'Deposit failed' : 'Burn failed',
        ),
      );
    }
  }

  useEffect(() => {
    if (!receipt.isSuccess) return;
    void Promise.all([srcBalance.refetch(), allowance.refetch()]).catch(() => {
      /* best-effort */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, activeHash]);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-white/70">Bridge</h2>
        <span className="text-xs text-white/40">lock-mint · 2-of-3 multisig</span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-black/30 p-1 text-xs">
        <button
          onClick={() => setDirection('etica-to-eth')}
          className={`rounded-lg py-2 ${
            direction === 'etica-to-eth' ? 'bg-white/10 text-white' : 'text-white/50'
          }`}
        >
          Etica → Ethereum
        </button>
        <button
          onClick={() => setDirection('eth-to-etica')}
          className={`rounded-lg py-2 ${
            direction === 'eth-to-etica' ? 'bg-white/10 text-white' : 'text-white/50'
          }`}
        >
          Ethereum → Etica
        </button>
      </div>

      <div className="mt-4 space-y-3">
        <div className="rounded-xl border border-white/10 bg-black/30 p-4">
          <div className="flex items-center justify-between gap-3">
            <input
              value={amountStr}
              onChange={(e) => setAmountStr(sanitizeNumber(e.target.value))}
              inputMode="decimal"
              placeholder="0.0"
              className="w-full bg-transparent text-2xl outline-none placeholder:text-white/30"
              aria-label="Amount"
            />
            <span className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm">
              {ctx?.srcTokenLabel ?? 'ETI'}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs text-white/40">
            <span>From {labelForSourceChain(direction)}</span>
            <button
              onClick={() => setAmountStr(formatUnits(srcBal, 18))}
              disabled={srcBal === 0n}
              className="hover:text-white/80 disabled:cursor-default disabled:hover:text-white/40"
            >
              Balance: {truncate(formatUnits(srcBal, 18), 6)}
            </button>
          </div>
        </div>

        <label className="block">
          <span className="text-xs text-white/50">
            Recipient on {labelForDestChain(direction)}
          </span>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value.trim())}
            placeholder="0x…"
            className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm outline-none placeholder:text-white/30"
            aria-label="Recipient"
            spellCheck={false}
          />
          {!validRecipient && recipient.length > 0 && (
            <span className="mt-1 block text-xs text-rose-400">
              Must be a 0x-prefixed 40-char address.
            </span>
          )}
        </label>
      </div>

      <dl className="mt-3 space-y-1 text-xs text-white/50">
        <Row k="Route">
          {ctx ? `${ctx.srcTokenLabel} → ${ctx.dstTokenLabel}` : '—'}
        </Row>
        <Row k="Destination chain">
          {ctx ? `chain ${ctx.dstChainId}` : '—'}
        </Row>
        <Row k="Fee model">Charged on destination only</Row>
      </dl>

      <BridgeButton
        isConnected={isConnected}
        ctx={ctx}
        amount={amount}
        hasEnoughBalance={hasEnoughBalance}
        validRecipient={validRecipient}
        needsApproval={needsApproval}
        isTxPending={isTxPending || receipt.isLoading}
        onApprove={onApprove}
        onLock={onLock}
      />

      {activeHash && receipt.isSuccess && lastTxType === 'approve' && (
        <p className="mt-3 break-all text-center text-xs text-emerald-400">
          Approved · tx {activeHash.slice(0, 10)}…{activeHash.slice(-8)}. Now
          submit the {ctx?.direction === 'etica-to-eth' ? 'lock' : 'burn'}.
        </p>
      )}
      {activeHash && receipt.isSuccess && lastTxType === 'lock' && (
        <p className="mt-3 break-all text-center text-xs text-emerald-400">
          {ctx?.direction === 'etica-to-eth' ? 'Locked' : 'Burned'} · tx{' '}
          {activeHash.slice(0, 10)}…{activeHash.slice(-8)}. Validators are
          now signing; switch to the destination chain to claim.
        </p>
      )}
      {activeHash && receipt.isError && (
        <p className="mt-3 text-center text-xs text-rose-400">Transaction reverted.</p>
      )}
      {submitError && (
        <p className="mt-3 break-words text-center text-xs text-rose-400">{submitError}</p>
      )}

      <p className="mt-4 rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-white/50">
        Bridge contracts are not deployed yet. This UI previews the flow that
        ships after the Phase 3 audit. No funds can be lost by clicking around
        while deployments are unset.
      </p>
    </div>
  );
}

function BridgeButton(props: {
  isConnected: boolean;
  ctx: BridgeCtx | null;
  amount: bigint;
  hasEnoughBalance: boolean;
  validRecipient: boolean;
  needsApproval: boolean;
  isTxPending: boolean;
  onApprove: () => Promise<void>;
  onLock: () => Promise<void>;
}) {
  const base =
    'mt-4 w-full rounded-xl py-3 font-medium disabled:opacity-50 disabled:cursor-not-allowed';
  const active = 'bg-brand-accent text-brand-ink hover:opacity-90';
  const subdued = 'bg-white/10 text-white/60';

  if (!props.isConnected) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Connect wallet to continue
      </button>
    );
  }
  if (!props.ctx) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Bridge not deployed on this chain
      </button>
    );
  }
  if (props.amount === 0n) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Enter an amount
      </button>
    );
  }
  if (!props.validRecipient) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Enter a recipient address
      </button>
    );
  }
  if (!props.hasEnoughBalance) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Insufficient balance
      </button>
    );
  }
  if (props.needsApproval) {
    return (
      <button
        onClick={props.onApprove}
        disabled={props.isTxPending}
        className={`${base} ${active}`}
      >
        {props.isTxPending ? 'Approving…' : `Approve ${props.ctx.srcTokenLabel}`}
      </button>
    );
  }
  const verb = props.ctx.direction === 'etica-to-eth' ? 'Lock & bridge' : 'Burn & bridge';
  return (
    <button
      onClick={props.onLock}
      disabled={props.isTxPending}
      className={`${base} ${active}`}
    >
      {props.isTxPending ? 'Submitting…' : verb}
    </button>
  );
}

function Row(props: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <dt>{props.k}</dt>
      <dd className="text-white/80">{props.children}</dd>
    </div>
  );
}

function labelForSourceChain(dir: BridgeDirection): string {
  return dir === 'etica-to-eth' ? 'Etica' : 'Ethereum';
}

function labelForDestChain(dir: BridgeDirection): string {
  return dir === 'etica-to-eth' ? 'Ethereum' : 'Etica';
}

function truncate(s: string, maxDecimals: number): string {
  const [whole, frac = ''] = s.split('.');
  if (!frac) return whole;
  return `${whole}.${frac.slice(0, maxDecimals)}`;
}

function sanitizeNumber(v: string): string {
  const cleaned = v.replace(/[^\d.]/g, '');
  const firstDot = cleaned.indexOf('.');
  if (firstDot === -1) return cleaned;
  return `${cleaned.slice(0, firstDot + 1)}${cleaned.slice(firstDot + 1).replace(/\./g, '')}`;
}

function describeWriteError(err: unknown, fallback: string): string | undefined {
  if (err instanceof BaseError) {
    const rejected = err.walk((e) => e instanceof UserRejectedRequestError);
    if (rejected) return undefined;
    return err.shortMessage || err.message || fallback;
  }
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}
