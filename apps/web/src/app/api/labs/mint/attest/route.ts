/**
 * EticaResearchNFT mint attestation endpoint.
 *
 * POST /api/labs/mint/attest
 *   body: { jobId: string, candidateIndex?: number }
 *   returns: {
 *     payload: ClaimPayload,
 *     signature: 0x-hex,
 *     nftAddress: 0x-hex,
 *     mintFeeWei: string,          // base + score-indexed slice
 *     baseMintFeeWei: string,      // contract immutable
 *     maxScoreMintFeeWei: string,  // contract immutable
 *     exclusive: boolean,          // true iff caller can still claim
 *   }
 *
 * The attestor private key (LABS_ATTESTOR_PRIVATE_KEY) only authorises
 * mints — it cannot touch already-minted NFTs. Signing happens
 * server-side so the key never leaves Vercel env. The discoverer's
 * wallet then calls EticaResearchNFT.claim(payload, sig) with the
 * returned EGAZ fee in msg.value.
 *
 * Open to any caller: every published candidate is already public on
 * /labs/feed; the attestation only encodes the existing record so any
 * wallet (incl. third-party tooling) can drive the on-chain claim.
 * Auto-forfeit (anyone-claims-to-treasury) is what the post-7d window
 * is for, and is handled by the contract directly.
 */

import { NextRequest } from 'next/server';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { DEPLOYMENTS, eticaMainnet } from '@etica-hub/shared';
import { getGoal } from '@/lib/labs/goal-store';
import { labsQueue } from '@/lib/labs/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/** 1 EGAZ (1e16 wei) — matches the deployer form default. */
const BASE_MINT_FEE_WEI = 10_000_000_000_000_000n;
/** 9 EGAZ (99e16 wei) — matches the deployer form default. */
const MAX_SCORE_MINT_FEE_WEI = 990_000_000_000_000_000n;

/** EIP-712 mint authorisation window (relative to now). */
const SIGNATURE_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Exclusive-claim window anchored to the candidate's job completion. */
const EXCLUSIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const CLAIM_TYPES = {
  ClaimPayload: [
    { name: 'parentGoalTitle', type: 'string' },
    { name: 'sequence', type: 'string' },
    { name: 'analysis', type: 'string' },
    { name: 'score', type: 'uint256' },
    { name: 'iterations', type: 'uint256' },
    { name: 'branchGoalId', type: 'string' },
    { name: 'submitter', type: 'address' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'exclusiveUntil', type: 'uint64' },
    { name: 'parentBranchGoalId', type: 'string' },
  ],
} as const;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function isAddress(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function normalisePrivateKey(raw: string | undefined): Hex | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) return null;
  return `0x${hex}` as Hex;
}

function clampScoreBasisPoints(score: number | undefined): bigint {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0n;
  const bps = Math.round(score * 10_000);
  if (bps < 0) return 0n;
  if (bps > 10_000) return 10_000n;
  return BigInt(bps);
}

function computeMintFeeWei(scoreBps: bigint): bigint {
  // Mirrors contract logic: BASE + (MAX_SCORE * score / 10000).
  return BASE_MINT_FEE_WEI + (MAX_SCORE_MINT_FEE_WEI * scoreBps) / 10_000n;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: { jobId?: unknown; candidateIndex?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON payload.' }, { status: 400 });
  }

  const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
  if (!jobId) {
    return json({ error: 'jobId is required.' }, { status: 400 });
  }

  const candidateIndex =
    typeof body.candidateIndex === 'number' && Number.isFinite(body.candidateIndex)
      ? Math.max(0, Math.floor(body.candidateIndex))
      : 0;

  const job = await labsQueue().get(jobId);
  if (!job) {
    return json({ error: 'Job not found.' }, { status: 404 });
  }
  if (!job.result || !job.result.candidates || job.result.candidates.length === 0) {
    return json({ error: 'Job has no candidates yet.' }, { status: 409 });
  }
  const candidate =
    job.result.candidates.find((c) => c.index === candidateIndex) ??
    job.result.candidates[Math.min(candidateIndex, job.result.candidates.length - 1)];
  if (!candidate) {
    return json({ error: 'Candidate not found.' }, { status: 404 });
  }
  if (!candidate.sequence) {
    return json({ error: 'Candidate has no sequence.' }, { status: 409 });
  }

  if (!job.goalId) {
    return json({ error: 'Job is not attached to a goal.' }, { status: 409 });
  }
  const goal = await getGoal(job.goalId);
  if (!goal) {
    return json({ error: 'Parent goal not found.' }, { status: 404 });
  }

  const submitter = job.submitterWallet;
  if (!isAddress(submitter)) {
    return json({ error: 'Job is missing a submitter wallet.' }, { status: 409 });
  }

  const chainId = eticaMainnet.id;
  const nftAddress = DEPLOYMENTS[chainId].eticaResearchNft;
  if (!isAddress(nftAddress) || nftAddress === '0x0000000000000000000000000000000000000000') {
    return json(
      { error: 'EticaResearchNFT is not deployed on chain 61803 yet.' },
      { status: 503 },
    );
  }

  const privateKey = normalisePrivateKey(process.env.LABS_ATTESTOR_PRIVATE_KEY);
  if (!privateKey) {
    return json({ error: 'Attestor key is not configured.' }, { status: 500 });
  }

  const now = Date.now();
  const candidateAnchorMs = job.updatedAt || job.createdAt || now;
  const exclusiveUntilMs = candidateAnchorMs + EXCLUSIVE_WINDOW_MS;
  const expiresAtMs = now + SIGNATURE_VALIDITY_MS;

  const scoreBps = clampScoreBasisPoints(candidate.score);
  const mintFeeWei = computeMintFeeWei(scoreBps);

  const payload = {
    parentGoalTitle: goal.title,
    sequence: candidate.sequence,
    analysis: candidate.analysis ?? '',
    score: scoreBps,
    iterations: BigInt(job.iterations ?? 0),
    branchGoalId: job.goalId,
    submitter,
    expiresAt: BigInt(Math.floor(expiresAtMs / 1000)),
    exclusiveUntil: BigInt(Math.floor(exclusiveUntilMs / 1000)),
    parentBranchGoalId: goal.parentGoalId ?? '',
  } as const;

  const account = privateKeyToAccount(privateKey);
  const signature = await account.signTypedData({
    domain: {
      name: 'EticaResearchNFT',
      version: '1',
      chainId,
      verifyingContract: nftAddress,
    },
    types: CLAIM_TYPES,
    primaryType: 'ClaimPayload',
    message: payload,
  });

  return json({
    payload: {
      parentGoalTitle: payload.parentGoalTitle,
      sequence: payload.sequence,
      analysis: payload.analysis,
      score: payload.score.toString(),
      iterations: payload.iterations.toString(),
      branchGoalId: payload.branchGoalId,
      submitter: payload.submitter,
      expiresAt: payload.expiresAt.toString(),
      exclusiveUntil: payload.exclusiveUntil.toString(),
      parentBranchGoalId: payload.parentBranchGoalId,
    },
    signature,
    nftAddress,
    chainId,
    mintFeeWei: mintFeeWei.toString(),
    baseMintFeeWei: BASE_MINT_FEE_WEI.toString(),
    maxScoreMintFeeWei: MAX_SCORE_MINT_FEE_WEI.toString(),
    exclusive: now <= exclusiveUntilMs,
    exclusiveUntil: payload.exclusiveUntil.toString(),
  });
}
