/**
 * "Mint as RES" button for /labs/feed/[id] candidate cards.
 *
 * Flow:
 *   1. Fetch the EIP-712 attestation from /api/labs/mint/attest.
 *   2. Show the user the mint fee (1 EGAZ base + score-indexed, max 10
 *      EGAZ) and the recipient policy (their wallet inside the
 *      exclusive window, treasury after 7d).
 *   3. On confirm, call EticaResearchNFT.claim(payload, sig) with
 *      msg.value = mintFeeWei. The contract _safeMints the RES to
 *      msg.sender inside the exclusive window, so the NFT lands
 *      directly in the discoverer's wallet.
 *
 * The attestor private key never leaves the server. The user only
 * signs the on-chain tx in their wallet.
 */

'use client';

import { useState } from 'react';
import { formatEther, type Hex } from 'viem';
import { useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi';

import { DEPLOYMENTS, eticaMainnet } from '@etica-hub/shared';
import eticaResearchNftArtifact from '@/lib/etica-research-nft-artifact.json';

type AttestResponse = {
  payload: {
    parentGoalTitle: string;
    sequence: string;
    analysis: string;
    score: string;
    iterations: string;
    branchGoalId: string;
    submitter: Hex;
    expiresAt: string;
    exclusiveUntil: string;
    marketOpenUntil: string;
    parentBranchGoalId: string;
  };
  signature: Hex;
  nftAddress: Hex;
  chainId: number;
  mintFeeWei: string;
  baseMintFeeWei: string;
  maxScoreMintFeeWei: string;
  exclusive: boolean;
  marketOpen: boolean;
  tier: 'originator' | 'market' | 'treasury';
  exclusiveUntil: string;
  marketOpenUntil: string;
};

type AttestError = { error?: string };

type TxStatus =
  | { kind: 'idle' }
  | { kind: 'attesting' }
  | { kind: 'ready'; attest: AttestResponse }
  | { kind: 'signing'; attest: AttestResponse }
  | { kind: 'pending'; attest: AttestResponse; hash: Hex }
  | { kind: 'confirmed'; attest: AttestResponse; hash: Hex; tokenId?: bigint }
  | { kind: 'error'; message: string; attest?: AttestResponse };

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return 'expired';
  const d = Math.floor(seconds / 86_400);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(seconds / 3_600);
  if (h >= 1) return `${h}h`;
  const m = Math.floor(seconds / 60);
  if (m >= 1) return `${m}m`;
  return `${seconds}s`;
}

function shortError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    const shortMatch = /reverted with the following reason:\s*(.+?)\n/.exec(msg);
    if (shortMatch) return shortMatch[1];
    return msg.length > 240 ? `${msg.slice(0, 240)}…` : msg;
  }
  return 'Mint failed.';
}

export function MintResButton({
  jobId,
  candidateIndex,
  submitter,
  hasSequence,
}: {
  jobId: string;
  candidateIndex: number;
  submitter: Hex | undefined;
  hasSequence: boolean;
}): JSX.Element | null {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: eticaMainnet.id });
  const { data: walletClient } = useWalletClient({ chainId: eticaMainnet.id });

  const [tx, setTx] = useState<TxStatus>({ kind: 'idle' });

  if (!hasSequence) return null;
  if (!submitter) return null;

  const nftAddress = DEPLOYMENTS[eticaMainnet.id].eticaResearchNft;
  const notDeployed =
    !nftAddress || nftAddress === '0x0000000000000000000000000000000000000000';

  const onWrongChain = isConnected && chainId !== eticaMainnet.id;
  const isSubmitterWallet =
    !!address && address.toLowerCase() === submitter.toLowerCase();

  async function handleAttest(): Promise<void> {
    setTx({ kind: 'attesting' });
    try {
      const res = await fetch('/api/labs/mint/attest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, candidateIndex }),
      });
      const body = (await res.json().catch(() => ({}))) as AttestResponse & AttestError;
      if (!res.ok || !body.signature) {
        setTx({ kind: 'error', message: body.error ?? `Attest failed (${res.status}).` });
        return;
      }
      setTx({ kind: 'ready', attest: body });
    } catch (err) {
      setTx({ kind: 'error', message: shortError(err) });
    }
  }

  async function handleMint(attest: AttestResponse): Promise<void> {
    if (!walletClient || !publicClient) {
      setTx({ kind: 'error', message: 'Wallet client unavailable.', attest });
      return;
    }
    setTx({ kind: 'signing', attest });
    try {
      const payloadTuple = {
        parentGoalTitle: attest.payload.parentGoalTitle,
        sequence: attest.payload.sequence,
        analysis: attest.payload.analysis,
        score: BigInt(attest.payload.score),
        iterations: BigInt(attest.payload.iterations),
        branchGoalId: attest.payload.branchGoalId,
        submitter: attest.payload.submitter,
        expiresAt: BigInt(attest.payload.expiresAt),
        exclusiveUntil: BigInt(attest.payload.exclusiveUntil),
        marketOpenUntil: BigInt(attest.payload.marketOpenUntil),
        parentBranchGoalId: attest.payload.parentBranchGoalId,
      } as const;

      const hash = await walletClient.writeContract({
        address: attest.nftAddress,
        abi: eticaResearchNftArtifact.abi,
        functionName: 'claim',
        args: [payloadTuple, attest.signature],
        value: BigInt(attest.mintFeeWei),
      });
      setTx({ kind: 'pending', attest, hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setTx({ kind: 'error', message: 'Mint tx reverted on chain.', attest });
        return;
      }
      setTx({ kind: 'confirmed', attest, hash });
    } catch (err) {
      setTx({ kind: 'error', message: shortError(err), attest });
    }
  }

  // Render: contract not deployed yet
  if (notDeployed) {
    return (
      <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-[11px] text-white/55">
        EticaResearchNFT is not deployed on chain 61803 yet — minting unlocks once
        the deployer lands.
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-white/5 pt-3">
      {tx.kind === 'idle' && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void handleAttest();
            }}
            disabled={!isConnected}
            className="rounded border border-sky-300/40 bg-sky-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-sky-100 transition-colors hover:border-sky-200/60 hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            mint as RES
          </button>
          <span className="text-[11px] text-white/45">
            mints the on-chain RES NFT directly to your wallet
          </span>
          {!isConnected && (
            <span className="text-[11px] text-amber-200/80">
              connect your wallet to mint
            </span>
          )}
        </div>
      )}

      {tx.kind === 'attesting' && (
        <p className="text-[11px] text-white/65">Preparing attestation…</p>
      )}

      {(tx.kind === 'ready' || tx.kind === 'signing' || tx.kind === 'pending') && (
        <MintConfirm
          status={tx}
          onWrongChain={onWrongChain}
          isSubmitterWallet={isSubmitterWallet}
          onConfirm={() => {
            void handleMint(tx.attest);
          }}
          onCancel={() => setTx({ kind: 'idle' })}
        />
      )}

      {tx.kind === 'confirmed' && (
        <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/[0.06] p-3 text-[12px] text-emerald-100">
          <p>RES minted. Tx: <code className="break-all">{tx.hash}</code></p>
          <button
            type="button"
            onClick={() => setTx({ kind: 'idle' })}
            className="mt-2 text-[11px] uppercase tracking-wider text-emerald-200/80 hover:text-emerald-100"
          >
            mint another
          </button>
        </div>
      )}

      {tx.kind === 'error' && (
        <div className="rounded-lg border border-rose-400/30 bg-rose-400/[0.06] p-3 text-[12px] text-rose-200">
          <p>{tx.message}</p>
          <button
            type="button"
            onClick={() => setTx({ kind: 'idle' })}
            className="mt-2 text-[11px] uppercase tracking-wider text-rose-200/80 hover:text-rose-100"
          >
            try again
          </button>
        </div>
      )}
    </div>
  );
}

function MintConfirm({
  status,
  onWrongChain,
  isSubmitterWallet,
  onConfirm,
  onCancel,
}: {
  status: Extract<TxStatus, { kind: 'ready' | 'signing' | 'pending' }>;
  onWrongChain: boolean;
  isSubmitterWallet: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const attest = status.attest;
  const exclusive = attest.exclusive;
  const tier = attest.tier;
  const exclusiveUntilMs = Number(BigInt(attest.exclusiveUntil)) * 1000;
  const marketOpenUntilMs = Number(BigInt(attest.marketOpenUntil)) * 1000;
  // Countdown to the end of the active window for this tier.
  const windowEndMs = exclusive ? exclusiveUntilMs : marketOpenUntilMs;
  const remainingSec = Math.max(0, Math.floor((windowEndMs - Date.now()) / 1000));
  const mintFeeEth = formatEther(BigInt(attest.mintFeeWei));

  const busy = status.kind === 'signing' || status.kind === 'pending';

  return (
    <div className="space-y-2 rounded-lg border border-sky-400/20 bg-sky-400/[0.04] p-3">
      <p className="text-[11px] uppercase tracking-wider text-sky-200/80">
        confirm mint
      </p>
      <dl className="grid grid-cols-2 gap-2 text-[12px] text-white/85">
        <div>
          <dt className="text-[10px] uppercase tracking-wider text-white/45">fee</dt>
          <dd className="font-mono">{mintFeeEth} EGAZ</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wider text-white/45">recipient</dt>
          <dd>
            {tier === 'treasury'
              ? 'treasury (window expired)'
              : 'your wallet (msg.sender)'}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wider text-white/45">
            {tier === 'originator'
              ? 'originator window'
              : tier === 'market'
                ? 'open market'
                : 'window'}
          </dt>
          <dd>{tier === 'treasury' ? 'expired' : `${formatRemaining(remainingSec)} left`}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wider text-white/45">contract</dt>
          <dd className="truncate font-mono text-[10px]">{attest.nftAddress}</dd>
        </div>
      </dl>

      {tier === 'originator' && !isSubmitterWallet && (
        <p className="text-[11px] text-amber-200/85">
          Only the original submitter wallet ({attest.payload.submitter.slice(0, 6)}…
          {attest.payload.submitter.slice(-4)}) can mint inside the first-24h originator
          window. The mint will revert if you proceed from another wallet.
        </p>
      )}

      {tier === 'market' && (
        <p className="text-[11px] text-emerald-200/85">
          Open market — anyone can mint this discovery to their own wallet now. After
          the window closes it auto-forfeits to the treasury.
        </p>
      )}

      {tier === 'treasury' && (
        <p className="text-[11px] text-amber-200/85">
          The 7-day mint window has expired. Anyone can call claim now, but the
          NFT will be force-minted to the immutable treasury (mint fee is waived).
        </p>
      )}

      {onWrongChain && (
        <p className="text-[11px] text-rose-300/85">
          Switch your wallet to Etica mainnet (chain id 61803) before minting.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded border border-white/10 px-2.5 py-1 text-[11px] uppercase tracking-wider text-white/70 transition-colors hover:border-white/30 hover:text-white disabled:opacity-50"
        >
          cancel
        </button>
        <button
          type="button"
          disabled={busy || onWrongChain}
          onClick={onConfirm}
          className="rounded border border-sky-300/40 bg-sky-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-sky-100 transition-colors hover:border-sky-200/60 hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status.kind === 'pending'
            ? 'awaiting confirmation…'
            : status.kind === 'signing'
              ? 'sign in wallet…'
              : 'sign & mint'}
        </button>
      </div>
    </div>
  );
}
