/**
 * User-facing endpoint: branch a child goal from a *minted* RES NFT.
 *
 * Unlike branch-from-candidate (which keys off a live queue job, subject
 * to the 7-day job TTL), this reads the parent context straight from the
 * on-chain Discovery record, so anyone can branch from any minted RES at
 * any time — including long after the originating job has aged out.
 *
 * POST /api/labs/goals/branch-from-token
 *   body: {
 *     tokenId: string | number,
 *     prompt: string,            // first-job prompt for the new branch
 *     wallet: 0x.., signature: 0x.., issuedAt: number,
 *   }
 *   returns: { ok, goalId, jobId, parentBranchGoalId } | { error }
 *
 * Cascade: the child goal is created with
 *   parentGoalId = discovery.branchGoalId
 * which is exactly the parent NFT's on-chain branch id. When the child is
 * later minted, /api/labs/mint/attest emits
 *   parentBranchGoalId = childGoal.parentGoalId
 * so the contract wires the new RES into the ancestor cascade and every
 * future sale of the descendant pays royalties up to this NFT.
 *
 * Branching is intentionally permissionless (you need not own the NFT) —
 * the wallet signature only binds submitter identity for rate-limiting
 * and provenance, mirroring branch-from-candidate.
 *
 * Safety: per-IP rate-limit, Layer 1 + Layer 2 moderation on the combined
 * text, global pending cap, and per-parent daily expansion budget.
 */
import { createHash, randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import type { Hex } from 'viem';

import { DEPLOYMENTS, eticaMainnet } from '@etica-hub/shared';
import { attachJobToGoal, createGoal, updateGoal } from '@/lib/labs/goal-store';
import {
  EXPAND_PENDING_CAP,
  incrDailyExpansionCount,
} from '@/lib/labs/expansion';
import {
  MAX_GOAL_DESCRIPTION,
  MAX_GOAL_TITLE,
} from '@/lib/labs/goal';
import type { LabsJob } from '@/lib/labs/job';
import { runBiomedicalGate, runHardDenylist } from '@/lib/labs/moderation';
import { consumeLabsRateLimit, getClientIp } from '@/lib/labs/rate-limit';
import { appendJobEvent, labsQueue } from '@/lib/labs/queue';
import { getResearchClient } from '@/lib/research';
import { verifySubmitPayload } from '@/lib/labs/submit-auth';
import eticaResearchNftArtifact from '@/lib/etica-research-nft-artifact.json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const MAX_PROMPT_CHARS = 400;
const DEFAULT_MAX_ITERATIONS = 3;

interface Discovery {
  parentGoalTitle: string;
  sequence: string;
  analysis: string;
  score: bigint;
  iterations: bigint;
  branchGoalId: string;
  submitter: string;
  discoveredAt: bigint;
  blockNumber: bigint;
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function submitterTag(req: NextRequest): string {
  const ip = getClientIp(req);
  if (!ip || ip === 'unknown') return 'anon';
  return createHash('sha256').update(ip).digest('hex').slice(0, 12);
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

export async function POST(req: NextRequest): Promise<Response> {
  const limit = await consumeLabsRateLimit(req);
  if (!limit.ok) {
    return json(limit.body, { status: limit.status, headers: limit.headers });
  }

  let body: {
    tokenId?: unknown;
    prompt?: unknown;
    wallet?: unknown;
    signature?: unknown;
    issuedAt?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON payload.' }, { status: 400, headers: limit.headers });
  }

  const tokenIdRaw =
    typeof body.tokenId === 'string' || typeof body.tokenId === 'number'
      ? String(body.tokenId).trim()
      : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

  if (!/^\d+$/.test(tokenIdRaw)) {
    return json({ error: 'A numeric tokenId is required.' }, { status: 400, headers: limit.headers });
  }
  if (!prompt) {
    return json({ error: 'Prompt is required.' }, { status: 400, headers: limit.headers });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json(
      { error: `Prompt must be ${MAX_PROMPT_CHARS} characters or fewer.` },
      { status: 400, headers: limit.headers },
    );
  }

  const signedPayload = `branch-token:${tokenIdRaw}|${prompt}`;
  const auth = await verifySubmitPayload({
    action: 'submit-job',
    payload: signedPayload,
    wallet: typeof body.wallet === 'string' ? body.wallet : '',
    signature: typeof body.signature === 'string' ? body.signature : '',
    issuedAt: typeof body.issuedAt === 'number' ? body.issuedAt : 0,
  });
  if (!auth.ok) {
    return json({ error: auth.error }, { status: auth.status, headers: limit.headers });
  }

  const nftAddress = DEPLOYMENTS[eticaMainnet.id].eticaResearchNft;
  if (!nftAddress || nftAddress === '0x0000000000000000000000000000000000000000') {
    return json(
      { error: 'EticaResearchNFT is not deployed yet.' },
      { status: 503, headers: limit.headers },
    );
  }

  // Read the parent context from chain — authoritative and TTL-free.
  let discovery: Discovery;
  try {
    const client = getResearchClient();
    const raw = await client.readContract({
      abi: eticaResearchNftArtifact.abi,
      address: nftAddress as Hex,
      functionName: 'discoveryOf',
      args: [BigInt(tokenIdRaw)],
    });
    discovery = raw as unknown as Discovery;
  } catch (err) {
    return json(
      { error: 'Failed to read the parent discovery on chain.', detail: err instanceof Error ? err.message : String(err) },
      { status: 502, headers: limit.headers },
    );
  }
  if (!discovery.sequence || discovery.sequence.length === 0) {
    return json(
      { error: 'Token not found or has no sequence.' },
      { status: 404, headers: limit.headers },
    );
  }

  const parentBranchGoalId = discovery.branchGoalId;
  if (!parentBranchGoalId) {
    return json(
      { error: 'Parent discovery has no branch id — cannot anchor a cascade.' },
      { status: 422, headers: limit.headers },
    );
  }
  const parentTitle = discovery.parentGoalTitle || `RES #${tokenIdRaw}`;

  // Moderation Layers 1 + 2 on the fresh user prompt + parent context.
  const sequenceSnippet = clamp(discovery.sequence, 200);
  const analysisSnippet = discovery.analysis ? clamp(discovery.analysis, 500) : '';
  const combined = `${prompt}\n${sequenceSnippet}\n${analysisSnippet}`;
  const deny = runHardDenylist(combined);
  if (!deny.ok) {
    return json(
      {
        error:
          'This branch is outside the scope of EticaLabs. Submissions are limited to biomedical and life-sciences research.',
      },
      { status: 403, headers: limit.headers },
    );
  }
  const nvidiaKey = process.env.NVIDIA_API_KEY ?? '';
  if (nvidiaKey || process.env.NVIDIA_API_KEYS) {
    const gate = await runBiomedicalGate(combined, nvidiaKey);
    if (gate.verdict === 'no') {
      return json(
        { error: 'EticaLabs branches must be biomedical or life-sciences research.' },
        { status: 403, headers: limit.headers },
      );
    }
  }

  // Global pending cap so a chain of branches can't fan out unbounded.
  const queue = labsQueue();
  const pendingCount = await queue.pendingCount().catch(() => 0);
  if (pendingCount >= EXPAND_PENDING_CAP) {
    return json(
      { error: 'Autopilot is at capacity. Try again in a few minutes.', pendingCount },
      { status: 503, headers: limit.headers },
    );
  }

  // Reserve a daily-expansion slot against the parent branch id so manual
  // branches share budget with the worker's strong-score branches.
  await incrDailyExpansionCount(parentBranchGoalId).catch(() => 0);

  const branchTitle = clamp(`Branch — ${parentTitle}`, MAX_GOAL_TITLE);
  const branchDescription = clamp(
    [
      `Branched from minted RES #${tokenIdRaw} (${parentTitle}).`,
      `Parent sequence (${discovery.sequence.length} aa): ${sequenceSnippet}`,
      analysisSnippet ? `Parent analysis: ${analysisSnippet}` : '',
      `User branch prompt: ${prompt}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    MAX_GOAL_DESCRIPTION,
  );

  const childGoal = await createGoal({
    title: branchTitle,
    description: branchDescription,
    submitterTag: submitterTag(req),
    submitterWallet: auth.wallet,
    parentGoalId: parentBranchGoalId,
    origin: 'branch',
  });

  const now = Date.now();
  const jobId = randomUUID();
  const job: LabsJob = {
    id: jobId,
    prompt,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    iterations: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    submitterTag: submitterTag(req),
    submitterWallet: auth.wallet,
    goalId: childGoal.id,
    moderation: 'visible',
    events: [
      {
        at: now,
        kind: 'queued',
        message: `Branch goal seeded from minted RES #${tokenIdRaw}.`,
        meta: {
          kind: 'branch',
          parentGoalId: parentBranchGoalId,
          tokenId: tokenIdRaw,
        },
      },
    ],
  };
  const stamped = appendJobEvent(job, {
    kind: 'note',
    message: 'User branch from a minted RES — extends the on-chain cascade.',
  });

  try {
    await queue.enqueue(stamped);
  } catch (err) {
    return json(
      {
        error: 'Failed to enqueue branch job.',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503, headers: limit.headers },
    );
  }
  await attachJobToGoal(childGoal.id, jobId, now).catch(() => {});
  await updateGoal(childGoal.id, { runCountDelta: 1, lastRunAt: now }).catch(() => {});

  return json(
    {
      ok: true,
      goalId: childGoal.id,
      jobId,
      parentBranchGoalId,
      tokenId: tokenIdRaw,
    },
    { status: 201, headers: limit.headers },
  );
}
