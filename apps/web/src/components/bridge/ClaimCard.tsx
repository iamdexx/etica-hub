'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  formatUnits,
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
  abis,
  isSupportedChainId,
} from '@etica-hub/shared';

/**
 * Second card: submit a destination-chain claim using the signatures the
 * relayer coordinator has collected for a given nonce.
 *
 * Users paste the `srcTxHash` and `nonce` they got when they locked/burned
 * on the source chain. UI polls the coordinator for collected sigs; when
 * `ready: true`, the "Claim" button becomes active and submits on the
 * destination chain the user's wallet is currently on.
 *
 * Pasted values from the source-chain flow are safe to share — they are
 * on-chain public data. No user secret ever transits the coordinator.
 */

type JsonSig = { validator: Address; signature: Hex; receivedAt: string };

interface CoordinatorRecord {
  nonce: Hex;
  digest: Hex;
  payload: {
    srcChainId: string;
    dstChainId: string;
    srcTxHash: Hex;
    nonce: Hex;
    token: Address;
    amount: string;
    recipient: Address;
  };
  signatures: JsonSig[];
  threshold: number;
  ready: boolean;
}

const DEFAULT_COORDINATOR_URL =
  process.env.NEXT_PUBLIC_BRIDGE_COORDINATOR_URL ?? '';

export function ClaimCard() {
  const chainId = useChainId();
  const { address, isConnected } = useAccount();

  const [coordinatorUrl, setCoordinatorUrl] = useState(DEFAULT_COORDINATOR_URL);
  const [nonce, setNonce] = useState('');
  const [record, setRecord] = useState<CoordinatorRecord | null>(null);
  const [fetchError, setFetchError] = useState<string | undefined>();
  const [submitError, setSubmitError] = useState<string | undefined>();

  const validNonce = /^0x[0-9a-fA-F]{64}$/.test(nonce);
  const trimmedCoordinator = coordinatorUrl.replace(/\/+$/, '');

  const poll = useCallback(async () => {
    if (!validNonce || !trimmedCoordinator) return;
    try {
      const res = await fetch(`${trimmedCoordinator}/signatures/${nonce}`);
      if (!res.ok) {
        setRecord(null);
        setFetchError(`coordinator: ${res.status}`);
        return;
      }
      const data = (await res.json()) as CoordinatorRecord;
      setRecord(data);
      setFetchError(undefined);
    } catch (err) {
      setFetchError((err as Error).message);
    }
  }, [nonce, trimmedCoordinator, validNonce]);

  useEffect(() => {
    if (!validNonce) return;
    void poll();
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, [poll, validNonce]);

  const destContract = useMemo<Address | null>(() => {
    if (!record) return null;
    const dst = Number(record.payload.dstChainId);
    if (dst === 61803 || dst === 31337) {
      if (!isSupportedChainId(dst)) return null;
      const v = DEPLOYMENTS[dst].bridgeVault;
      return v === '0x0000000000000000000000000000000000000000' ? null : v;
    }
    if (dst === 1 || dst === 11155111) {
      const m = BRIDGE_ETHEREUM_DEPLOYMENTS[dst]?.bridgeMinter;
      return m && m !== '0x0000000000000000000000000000000000000000' ? m : null;
    }
    return null;
  }, [record]);

  const walletOnDestChain = record ? chainId === Number(record.payload.dstChainId) : false;

  const sigsAscending = useMemo<Hex[]>(() => {
    if (!record) return [];
    return [...record.signatures]
      .sort((a, b) => (a.validator.toLowerCase() < b.validator.toLowerCase() ? -1 : 1))
      .map((s) => s.signature);
  }, [record]);

  const alreadyProcessed = useReadContract({
    abi: abis.eticaBridgeVaultAbi,
    address: destContract ?? undefined,
    functionName: 'processed',
    args: record ? [record.nonce] : undefined,
    query: { enabled: Boolean(destContract && record) },
  });

  const {
    writeContractAsync,
    data: txHash,
    isPending: isTxPending,
    reset: resetWrite,
  } = useWriteContract();
  const [pendingTxHash, setPendingTxHash] = useState<Hex | undefined>();
  const activeHash = pendingTxHash ?? txHash;
  const receipt = useWaitForTransactionReceipt({
    hash: activeHash,
    query: { enabled: Boolean(activeHash) },
  });

  async function onClaim() {
    if (!record || !destContract || !walletOnDestChain) return;
    setSubmitError(undefined);
    setPendingTxHash(undefined);
    resetWrite();
    const dst = Number(record.payload.dstChainId);
    const isEthereumDst = dst === 1 || dst === 11155111;
    try {
      const hash = await writeContractAsync({
        abi: isEthereumDst ? abis.ethereumBridgeMinterAbi : abis.eticaBridgeVaultAbi,
        address: destContract,
        functionName: isEthereumDst ? 'mint' : 'withdraw',
        args: [
          BigInt(record.payload.srcChainId),
          record.payload.srcTxHash,
          record.nonce,
          BigInt(record.payload.amount),
          record.payload.recipient,
          sigsAscending,
        ],
      });
      setPendingTxHash(hash);
    } catch (err) {
      setSubmitError(describeWriteError(err, 'Claim failed'));
    }
  }

  useEffect(() => {
    if (receipt.isSuccess) void alreadyProcessed.refetch().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess]);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-white/70">Claim on destination</h2>
        <span className="text-xs text-white/40">step 2 of 2</span>
      </div>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="text-xs text-white/50">Coordinator URL</span>
          <input
            value={coordinatorUrl}
            onChange={(e) => setCoordinatorUrl(e.target.value)}
            placeholder="https://relayer.eticahub.example"
            className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none placeholder:text-white/30"
            spellCheck={false}
          />
        </label>

        <label className="block">
          <span className="text-xs text-white/50">Nonce</span>
          <input
            value={nonce}
            onChange={(e) => setNonce(e.target.value.trim())}
            placeholder="0x… (from the lock/burn event)"
            className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs outline-none placeholder:text-white/30"
            spellCheck={false}
          />
          {nonce.length > 0 && !validNonce && (
            <span className="mt-1 block text-xs text-rose-400">
              Nonce must be a 0x-prefixed 64-char hex value.
            </span>
          )}
        </label>
      </div>

      <dl className="mt-4 space-y-1 text-xs text-white/50">
        <Row k="Signatures collected">
          {record ? `${record.signatures.length} / ${record.threshold}` : '—'}
        </Row>
        <Row k="Destination chain">
          {record
            ? `chain ${record.payload.dstChainId}${walletOnDestChain ? '' : ' (switch wallet)'}`
            : '—'}
        </Row>
        <Row k="Amount (gross)">
          {record ? `${truncate(formatUnits(BigInt(record.payload.amount), 18), 6)}` : '—'}
        </Row>
        <Row k="Recipient">{record?.payload.recipient ?? '—'}</Row>
        <Row k="Already processed">
          {alreadyProcessed.data === undefined
            ? '—'
            : alreadyProcessed.data
              ? 'yes'
              : 'no'}
        </Row>
      </dl>

      <ClaimButton
        isConnected={isConnected}
        hasAddress={Boolean(address)}
        record={record}
        destContract={destContract}
        walletOnDestChain={walletOnDestChain}
        alreadyProcessed={Boolean(alreadyProcessed.data)}
        isTxPending={isTxPending || receipt.isLoading}
        onClaim={onClaim}
      />

      {activeHash && receipt.isSuccess && (
        <p className="mt-3 break-all text-center text-xs text-emerald-400">
          Claimed · tx {activeHash.slice(0, 10)}…{activeHash.slice(-8)}
        </p>
      )}
      {activeHash && receipt.isError && (
        <p className="mt-3 text-center text-xs text-rose-400">Transaction reverted.</p>
      )}
      {submitError && (
        <p className="mt-3 break-words text-center text-xs text-rose-400">{submitError}</p>
      )}
      {fetchError && (
        <p className="mt-3 break-words text-center text-xs text-amber-400">
          Coordinator: {fetchError}
        </p>
      )}
    </div>
  );
}

function ClaimButton(props: {
  isConnected: boolean;
  hasAddress: boolean;
  record: CoordinatorRecord | null;
  destContract: Address | null;
  walletOnDestChain: boolean;
  alreadyProcessed: boolean;
  isTxPending: boolean;
  onClaim: () => Promise<void>;
}) {
  const base =
    'mt-4 w-full rounded-xl py-3 font-medium disabled:opacity-50 disabled:cursor-not-allowed';
  const active = 'bg-brand-accent text-brand-ink hover:opacity-90';
  const subdued = 'bg-white/10 text-white/60';

  if (!props.isConnected || !props.hasAddress) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Connect wallet to claim
      </button>
    );
  }
  if (!props.record) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Enter a nonce
      </button>
    );
  }
  if (!props.destContract) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Destination bridge not deployed
      </button>
    );
  }
  if (!props.walletOnDestChain) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Switch wallet to chain {props.record.payload.dstChainId}
      </button>
    );
  }
  if (!props.record.ready) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Waiting for validator signatures…
      </button>
    );
  }
  if (props.alreadyProcessed) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Already claimed
      </button>
    );
  }
  return (
    <button
      onClick={props.onClaim}
      disabled={props.isTxPending}
      className={`${base} ${active}`}
    >
      {props.isTxPending ? 'Claiming…' : 'Claim'}
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

function truncate(s: string, maxDecimals: number): string {
  const [whole, frac = ''] = s.split('.');
  if (!frac) return whole;
  return `${whole}.${frac.slice(0, maxDecimals)}`;
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
