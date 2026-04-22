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
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { abis } from '@etica-hub/shared';

interface StakeCardProps {
  stakedETX: Address;
  etx: Address;
}

type Tab = 'stake' | 'unstake';
type FlowState =
  | { status: 'idle' }
  | { status: 'approving'; hash?: Hex }
  | { status: 'staking'; hash?: Hex }
  | { status: 'unstaking'; hash?: Hex }
  | { status: 'error'; error: string };

const MAX_UINT256 = (1n << 256n) - 1n;
const MIN_DEPOSIT = 10n ** 18n; // 1 ETX, mirrors contract guard

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

/**
 * Primary deposit/withdraw widget for stETX.
 *
 * Stake tab: approves ETX (if needed), then calls {deposit}.
 * Unstake tab: calls {redeem} on the user's shares (no approval needed since
 * the vault burns the user's own shares).
 */
export function StakeCard({ stakedETX, etx }: StakeCardProps) {
  const { address, isConnected } = useAccount();
  const [tab, setTab] = useState<Tab>('stake');
  const [amount, setAmount] = useState('');
  const [flow, setFlow] = useState<FlowState>({ status: 'idle' });

  const reads = useReadContracts({
    allowFailure: false,
    contracts: address
      ? [
          {
            abi: abis.erc20Abi,
            address: etx,
            functionName: 'balanceOf',
            args: [address],
          } as const,
          {
            abi: abis.erc20Abi,
            address: etx,
            functionName: 'allowance',
            args: [address, stakedETX],
          } as const,
          {
            abi: abis.stakedEtxAbi,
            address: stakedETX,
            functionName: 'balanceOf',
            args: [address],
          } as const,
          {
            abi: abis.stakedEtxAbi,
            address: stakedETX,
            functionName: 'maxWithdraw',
            args: [address],
          } as const,
        ]
      : [],
    query: { enabled: Boolean(address), refetchInterval: 12_000 },
  });

  const [etxBalance, allowance, stetxBalance, maxWithdrawEtx] = (reads.data as
    | [bigint, bigint, bigint, bigint]
    | undefined) ?? [0n, 0n, 0n, 0n];

  // Preview outputs: how many stETX for N ETX (stake), or how much ETX for N stETX (unstake).
  const parsedAmount = useMemo<bigint | null>(() => {
    const t = amount.trim();
    if (!t) return null;
    try {
      return parseUnits(t, 18);
    } catch {
      return null;
    }
  }, [amount]);

  const previewStakeQuery = useReadContract({
    abi: abis.stakedEtxAbi,
    address: stakedETX,
    functionName: 'previewDeposit',
    args: parsedAmount !== null ? [parsedAmount] : undefined,
    query: { enabled: tab === 'stake' && parsedAmount !== null && parsedAmount > 0n },
  });

  const previewUnstakeQuery = useReadContract({
    abi: abis.stakedEtxAbi,
    address: stakedETX,
    functionName: 'previewRedeem',
    args: parsedAmount !== null ? [parsedAmount] : undefined,
    query: { enabled: tab === 'unstake' && parsedAmount !== null && parsedAmount > 0n },
  });

  const { writeContractAsync } = useWriteContract();
  const lastHash =
    flow.status === 'approving' || flow.status === 'staking' || flow.status === 'unstaking'
      ? flow.hash
      : undefined;
  const receiptQuery = useWaitForTransactionReceipt({
    hash: lastHash,
    query: { enabled: Boolean(lastHash) },
  });

  const busy =
    flow.status === 'approving' || flow.status === 'staking' || flow.status === 'unstaking';

  // When a tx confirms, reset flow + form + refetch balances.
  useEffect(() => {
    if (receiptQuery.isSuccess && lastHash) {
      setFlow({ status: 'idle' });
      setAmount('');
      void reads.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptQuery.isSuccess, lastHash]);

  const canStake =
    tab === 'stake' &&
    parsedAmount !== null &&
    parsedAmount >= MIN_DEPOSIT &&
    parsedAmount <= etxBalance;
  const canUnstake =
    tab === 'unstake' &&
    parsedAmount !== null &&
    parsedAmount > 0n &&
    parsedAmount <= stetxBalance;
  const needsApprove = tab === 'stake' && parsedAmount !== null && parsedAmount > allowance;

  async function onApprove() {
    if (!address || !parsedAmount) return;
    try {
      setFlow({ status: 'approving' });
      const hash = await writeContractAsync({
        abi: abis.erc20Abi,
        address: etx,
        functionName: 'approve',
        args: [stakedETX, MAX_UINT256],
      });
      setFlow({ status: 'approving', hash });
    } catch (err) {
      setFlow({ status: 'error', error: shortError(err) });
    }
  }

  async function onStake() {
    if (!address || !parsedAmount) return;
    try {
      setFlow({ status: 'staking' });
      const hash = await writeContractAsync({
        abi: abis.stakedEtxAbi,
        address: stakedETX,
        functionName: 'deposit',
        args: [parsedAmount, address],
      });
      setFlow({ status: 'staking', hash });
    } catch (err) {
      setFlow({ status: 'error', error: shortError(err) });
    }
  }

  async function onUnstake() {
    if (!address || !parsedAmount) return;
    try {
      setFlow({ status: 'unstaking' });
      const hash = await writeContractAsync({
        abi: abis.stakedEtxAbi,
        address: stakedETX,
        functionName: 'redeem',
        args: [parsedAmount, address, address],
      });
      setFlow({ status: 'unstaking', hash });
    } catch (err) {
      setFlow({ status: 'error', error: shortError(err) });
    }
  }

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
      <div className="mb-4 flex items-center gap-2 rounded-full border border-white/10 bg-white/5 p-1 text-sm">
        <TabButton active={tab === 'stake'} onClick={() => setTab('stake')}>
          Stake
        </TabButton>
        <TabButton active={tab === 'unstake'} onClick={() => setTab('unstake')}>
          Unstake
        </TabButton>
      </div>

      <label className="mb-2 block text-xs text-white/60">
        {tab === 'stake' ? 'Amount (ETX)' : 'Shares (stETX)'}
      </label>
      <div className="flex items-stretch gap-2">
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
          placeholder="0.0"
          spellCheck={false}
          className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm focus:border-brand-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() =>
            setAmount(
              formatUnits(tab === 'stake' ? etxBalance : stetxBalance, 18),
            )
          }
          disabled={!isConnected}
          className="rounded-lg border border-white/10 bg-white/5 px-3 text-xs text-white/70 transition hover:bg-white/10 disabled:opacity-40"
        >
          Max
        </button>
      </div>
      <div className="mt-1 text-[11px] text-white/40">
        {tab === 'stake' ? (
          <>
            Balance: {formatUnits(etxBalance, 18)} ETX · min deposit: 1 ETX
          </>
        ) : (
          <>Balance: {formatUnits(stetxBalance, 18)} stETX</>
        )}
      </div>

      <div className="mt-4 rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-white/60">
        <PreviewLine
          tab={tab}
          parsedAmount={parsedAmount}
          stakePreview={previewStakeQuery.data as bigint | undefined}
          unstakePreview={previewUnstakeQuery.data as bigint | undefined}
          maxWithdrawEtx={maxWithdrawEtx}
        />
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {tab === 'stake' && needsApprove && (
          <button
            type="button"
            onClick={onApprove}
            disabled={!isConnected || busy || !canStake}
            className="rounded-lg bg-brand-accent px-4 py-2 font-medium text-brand-ink transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            {flow.status === 'approving' ? 'Approving…' : 'Approve ETX'}
          </button>
        )}
        {tab === 'stake' && !needsApprove && (
          <button
            type="button"
            onClick={onStake}
            disabled={!isConnected || busy || !canStake}
            className="rounded-lg bg-brand-accent px-4 py-2 font-medium text-brand-ink transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            {flow.status === 'staking' ? 'Staking…' : 'Stake ETX'}
          </button>
        )}
        {tab === 'unstake' && (
          <button
            type="button"
            onClick={onUnstake}
            disabled={!isConnected || busy || !canUnstake}
            className="rounded-lg bg-brand-accent px-4 py-2 font-medium text-brand-ink transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            {flow.status === 'unstaking' ? 'Unstaking…' : 'Unstake'}
          </button>
        )}

        {flow.status === 'error' && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {flow.error}
          </div>
        )}
        {lastHash && receiptQuery.isLoading && (
          <div className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/60">
            Waiting for confirmation · <span className="font-mono">{lastHash.slice(0, 10)}…</span>
          </div>
        )}
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex-1 rounded-full px-3 py-1.5 text-sm transition ' +
        (active ? 'bg-brand-accent text-brand-ink' : 'text-white/70 hover:text-white')
      }
    >
      {children}
    </button>
  );
}

function PreviewLine({
  tab,
  parsedAmount,
  stakePreview,
  unstakePreview,
  maxWithdrawEtx,
}: {
  tab: Tab;
  parsedAmount: bigint | null;
  stakePreview?: bigint;
  unstakePreview?: bigint;
  maxWithdrawEtx: bigint;
}) {
  if (parsedAmount === null || parsedAmount === 0n) {
    return tab === 'stake' ? (
      <>Enter an amount above to preview stETX received.</>
    ) : (
      <>
        You can redeem up to <span className="font-mono text-white/80">{formatUnits(maxWithdrawEtx, 18)}</span>{' '}
        ETX from your shares.
      </>
    );
  }
  if (tab === 'stake') {
    if (stakePreview === undefined) return <>Calculating…</>;
    return (
      <>
        You receive ≈ <span className="font-mono text-white/80">{Number(formatUnits(stakePreview, 18)).toFixed(6)}</span>{' '}
        stETX at the current rate.
      </>
    );
  }
  if (unstakePreview === undefined) return <>Calculating…</>;
  return (
    <>
      You receive ≈ <span className="font-mono text-white/80">{Number(formatUnits(unstakePreview, 18)).toFixed(6)}</span>{' '}
      ETX at the current rate.
    </>
  );
}


